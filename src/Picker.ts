import { randomUUID } from "node:crypto";
import { Console, Effect, FileSystem, Path, Schema } from "effect";
import { Prompt } from "effect/unstable/cli";
import { Action, ActionError, pasteTarget, plain } from "./Actions";
import { RuntimeConfig, pluginId } from "./Config";
import { GitHub, attention } from "./GitHub";
import { Herdr, Origin, checkout } from "./Herdr";
import { Process } from "./Process";
import { start } from "./Watch";

export const open = Effect.gen(function* () {
  const herdr = yield* Herdr;
  const context = yield* Schema.decodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        workspace_id: Schema.String,
        focused_pane_id: Schema.String,
      }),
    ),
  )(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
  const pane = yield* herdr.pane(context.focused_pane_id);
  if (pane.workspace_id !== context.workspace_id)
    return yield* new ActionError({
      message: "The originating workspace changed",
    });
  const origin: Origin = {
    workspace: context.workspace_id,
    pane,
    processes: yield* herdr.processes(pane.pane_id),
  };
  yield* start;
  yield* herdr.request(
    "plugin.pane.open",
    {
      plugin_id: pluginId,
      entrypoint: "picker",
      placement: "popup",
      focus: true,
      env: { WORKFLOW_WATCH_ORIGIN: JSON.stringify(origin) },
    },
    Schema.Unknown,
  );
});

export const picker = Effect.gen(function* () {
  const origin = yield* Schema.decodeEffect(Schema.fromJsonString(Origin))(
    process.env.WORKFLOW_WATCH_ORIGIN ?? "{}",
  );
  const config = yield* RuntimeConfig;
  const herdr = yield* Herdr;
  const github = yield* GitHub;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const snapshot = yield* herdr.snapshot;
  const workspace = snapshot.workspaces.find(
    (value) => value.workspace_id === origin.workspace,
  );
  const cwd = workspace && checkout(workspace, snapshot.panes);
  const target = cwd ? yield* github.discover(cwd) : null;
  const status = target ? yield* github.status(target) : null;
  const failures =
    status?.runs.filter((run) => attention(run.conclusion)) ?? [];
  if (!target || !status || failures.length === 0) {
    yield* Prompt.select({
      message:
        target && status
          ? "No workflow failures on the latest pushed commit"
          : "No pushed GitHub branch to watch",
      choices: [{ title: "Close", value: "close" }],
    });
    return;
  }
  const run = yield* Prompt.select({
    message: plain(
      `${target.repository} / ${target.branch} / ${status.sha.slice(0, 8)}`,
    ),
    choices: [
      ...failures.map((value) => ({
        title: plain(
          `${value.name ?? value.display_title} (${value.conclusion}, attempt ${value.run_attempt})`,
        ),
        value,
      })),
      { title: "Close", value: null },
    ],
  });
  if (!run) return;
  const paste = yield* pasteTarget(origin).pipe(Effect.result);
  const action = yield* Prompt.select<typeof Action.Type | null>({
    message: "What next?",
    choices: [
      { title: "Open failure in browser", value: "browser" },
      {
        title: "Paste draft into original agent",
        value: "paste",
        disabled: paste._tag === "Failure",
        description: "Insert without submitting; requires the same ready agent",
      },
      {
        title: "New agent in this checkout",
        value: "checkout",
        disabled: !config.launcher,
      },
      {
        title: "New agent in a new worktree",
        value: "worktree",
        disabled: !config.launcher,
      },
      { title: "Close", value: null },
    ],
  });
  if (!action) return;
  const id = randomUUID();
  yield* fs.writeFileString(
    path.join(config.state, `selection-${id}.json`),
    JSON.stringify({ origin, target, run, action }),
    { mode: 0o600 },
  );
  yield* (yield* Process).detach("dispatch", { WORKFLOW_WATCH_SELECTION: id });
  // The worker closes this popup before changing layout or sending input.
  return yield* Effect.never;
}).pipe(
  Effect.catch((cause) =>
    Effect.gen(function* () {
      yield* Console.error(plain(String(cause)));
      yield* Prompt.select({
        message: "Workflow Watch unavailable",
        choices: [{ title: "Close", value: "close" }],
      });
    }),
  ),
);
