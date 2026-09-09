import { Effect, FileSystem, Path, Schema } from "effect";
import { launchAgent, pasteDraft } from "../actions/agent";
import { handoff } from "../actions/prompt";
import { ActionError, Selection } from "../actions/selection";
import { RuntimeConfig } from "../config";
import { GitHub, attention, targetKey } from "../services/github";
import { Herdr, checkout } from "../services/herdr";
import { Process } from "../services/process";
import { plain } from "../text";

export const dispatch = Effect.gen(function* () {
  const config = yield* RuntimeConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const id = yield* Schema.decodeUnknownEffect(
    Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/)),
  )(process.env.WORKFLOW_WATCH_SELECTION);
  const file = path.join(config.state, `selection-${id}.json`);
  const selection = yield* Schema.decodeEffect(
    Schema.fromJsonString(Selection),
  )(yield* fs.readFileString(file));
  yield* fs.remove(file);
  const herdr = yield* Herdr;
  yield* herdr.request("popup.close", {}, Schema.Unknown);
  const github = yield* GitHub;
  const commands = yield* Process;
  if (!(yield* herdr.enabled))
    return yield* new ActionError({ message: "Workflow Watch is disabled" });
  const snapshot = yield* herdr.snapshot;
  const workspace = snapshot.workspaces.find(
    (value) => value.workspace_id === selection.origin.workspace,
  );
  const cwd = workspace && checkout(workspace, snapshot.panes);
  const target = cwd ? yield* github.discover(cwd) : null;
  if (
    !target ||
    target.root !== selection.target.root ||
    targetKey(target) !== targetKey(selection.target) ||
    target.localBranch !== selection.target.localBranch
  ) {
    return yield* new ActionError({
      message:
        "The originating checkout or branch changed; reopen Workflow Watch",
    });
  }
  if (selection.action === "actions") {
    yield* commands.text("gh", [
      "browse",
      "--actions",
      "--repo",
      `github.com/${target.repository}`,
    ]);
    return;
  }
  const status = yield* github.status(target);
  const current = status?.runs.find((run) => run.id === selection.run.id);
  if (
    !current ||
    current.head_sha !== selection.run.head_sha ||
    current.run_attempt !== selection.run.run_attempt ||
    !attention(current.conclusion)
  ) {
    return yield* new ActionError({
      message: "The selected run changed or recovered; reopen Workflow Watch",
    });
  }
  if (!("launcher" in selection)) {
    if (selection.action === "browser") {
      yield* commands.text("gh", [
        "run",
        "view",
        String(current.id),
        "--repo",
        `github.com/${target.repository}`,
        "--web",
      ]);
    } else {
      yield* pasteDraft(selection.origin, yield* handoff(target, current));
    }
    return;
  }
  const prompt = yield* handoff(target, current);
  const pane = yield* herdr.pane(selection.origin.pane.pane_id);
  if (
    pane.workspace_id !== selection.origin.workspace ||
    pane.terminal_id !== selection.origin.pane.terminal_id
  ) {
    return yield* new ActionError({
      message: "The originating pane changed; reopen Workflow Watch",
    });
  }
  yield* launchAgent(
    selection.origin,
    target,
    current,
    selection.action,
    selection.launcher,
    prompt,
  );
}).pipe(
  Effect.catch((cause) =>
    Effect.gen(function* () {
      yield* Effect.logError(String(cause));
      yield* (yield* Herdr)
        .request(
          "notification.show",
          { title: "Workflow Watch action failed", body: plain(String(cause)) },
          Schema.Unknown,
        )
        .pipe(Effect.catch((error) => Effect.logError(String(error))));
    }),
  ),
);
