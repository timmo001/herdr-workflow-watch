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

export const Action = Schema.Literals([
  "browser",
  "paste",
  "checkout",
  "worktree",
]);
export const Selection = Schema.Union([
  Schema.Struct({
    origin: Origin,
    target: Target,
    run: Run,
    action: Schema.Literals(["browser", "paste"]),
  }),
  Schema.Struct({
    origin: Origin,
    target: Target,
    run: Run,
    action: Schema.Literals(["checkout", "worktree"]),
    launcher: Launcher,
  }),
  Schema.Struct({
    origin: Origin,
    target: Target,
    action: Schema.Literal("actions"),
  }),
]);
