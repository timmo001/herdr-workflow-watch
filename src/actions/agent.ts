import { randomUUID } from "node:crypto";
import { Effect, Schedule, Schema } from "effect";
import { RuntimeConfig } from "../config";
import type { Run, Target } from "../services/github";
import { Herdr, Pane, type Origin } from "../services/herdr";
import { Process } from "../services/process";
import { ActionError } from "./selection";

export const pasteTarget = Effect.fn("Actions.pasteTarget")(function* (
  origin: Origin,
) {
  const herdr = yield* Herdr;
  const pane = (yield* herdr.request(
    "agent.get",
    { target: origin.pane.pane_id },
    Schema.Struct({ agent: Pane }),
  )).agent;
  const processes = yield* herdr.processes(pane.pane_id);
  if (
    !origin.pane.agent ||
    pane.agent !== origin.pane.agent ||
    pane.workspace_id !== origin.workspace ||
    pane.terminal_id !== origin.pane.terminal_id ||
    pane.agent_session?.value !== origin.pane.agent_session?.value ||
    !["idle", "done"].includes(pane.agent_status) ||
    origin.processes.length === 0 ||
    JSON.stringify(processes) !== JSON.stringify(origin.processes)
  ) {
    return yield* new ActionError({
      message: "The original agent is no longer ready for a draft",
    });
  }
  return pane;
});

export const pasteDraft = Effect.fn("Actions.pasteDraft")(function* (
  origin: Origin,
  prompt: string,
) {
  const pane = yield* pasteTarget(origin);
  yield* (yield* Process).text(processEnvHerdr(), [
    "pane",
    "send-text",
    pane.pane_id,
    `\n${prompt}\n`,
  ]);
});

export const launchAgent = Effect.fn("Actions.launchAgent")(function* (
  origin: Origin,
  target: Target,
  run: Run,
  action: "checkout" | "worktree",
  prompt: string,
) {
  const config = yield* RuntimeConfig;
  const process = yield* Process;
  const herdr = yield* Herdr;
  const launcher = config.launcher;
  if (!launcher)
    return yield* new ActionError({
      message:
        "Configure launcher.argv, launcher.agent and launcher.verifyCommand first",
    });
  yield* process.text("test", ["-x", launcher.argv[0]]);
  let pane: typeof Pane.Type;
  if (action === "worktree") {
    const commit = yield* process.run(
      "git",
      ["cat-file", "-e", `${run.head_sha}^{commit}`],
      target.root,
    );
    if (commit.code !== 0)
      yield* process.text(
        "git",
        ["fetch", "--no-tags", "--", target.remote, run.head_sha],
        target.root,
      );
    yield* process.text(
      "git",
      ["cat-file", "-e", `${run.head_sha}^{commit}`],
      target.root,
    );
    pane = (yield* herdr.request(
      "worktree.create",
      {
        cwd: target.root,
        branch: `fix/workflow-${run.id}-${randomUUID().slice(0, 8)}`,
        base: run.head_sha,
        label: `Fix ${run.name ?? "workflow"}`,
        focus: true,
      },
      Schema.Struct({ root_pane: Pane }),
    )).root_pane;
  } else {
    pane = (yield* herdr.request(
      "pane.split",
      {
        target_pane_id: origin.pane.pane_id,
        workspace_id: origin.workspace,
        direction: "down",
        cwd: target.root,
        focus: true,
      },
      Schema.Struct({ pane: Pane }),
    )).pane;
  }
  const [verify, ...verifyArgs] = launcher.verifyCommand;
  const expected = yield* process.text(
    verify,
    verifyArgs,
    pane.cwd ?? target.root,
  );
  if (!expected || expected.includes("\n"))
    return yield* new ActionError({
      message: "Launcher verification must return one executable path",
    });
  yield* process.text("test", ["-x", expected]);
  const command = launcher.argv
    .map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)
    .join(" ");
  yield* process.text(processEnvHerdr(), [
    "pane",
    "run",
    pane.pane_id,
    command,
  ]);
  yield* Effect.gen(function* () {
    const agent = (yield* herdr.request(
      "agent.get",
      { target: pane.pane_id },
      Schema.Struct({ agent: Pane }),
    )).agent;
    const processes = yield* herdr.processes(pane.pane_id);
    if (
      agent.agent !== launcher.agent ||
      !["idle", "done"].includes(agent.agent_status) ||
      !processes.some((foreground) => foreground.argv.includes(expected))
    ) {
      return yield* new ActionError({
        message: `Waiting for ${launcher.agent} in ${pane.pane_id}`,
      });
    }
  }).pipe(
    Effect.retry({ times: 60, schedule: Schedule.spaced(500) }),
    Effect.timeout(30_000),
  );
  yield* herdr.request(
    "agent.prompt",
    { target: pane.pane_id, text: prompt },
    Schema.Unknown,
  );
});

function processEnvHerdr() {
  return process.env.HERDR_BIN_PATH ?? "herdr";
}
