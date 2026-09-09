import { Schema } from "effect";
import { Launcher } from "../config";
import { Run, Target } from "../services/github";
import { Origin } from "../services/herdr";

export class ActionError extends Schema.TaggedError<ActionError>()(
  "ActionError",
  {
    message: Schema.String,
  },
) {}

const RunAction = Schema.Literals(["browser", "paste"]);
export const LaunchAction = Schema.Literals(["checkout", "worktree"]);
export const Action = Schema.Union([RunAction, LaunchAction]);
export const Selection = Schema.Union([
  Schema.Struct({
    origin: Origin,
    target: Target,
    run: Run,
    action: RunAction,
  }),
  Schema.Struct({
    origin: Origin,
    target: Target,
    run: Run,
    action: LaunchAction,
    launcher: Launcher,
  }),
  Schema.Struct({
    origin: Origin,
    target: Target,
    action: Schema.Literal("actions"),
  }),
]);
