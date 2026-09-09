import { Schema } from "effect";
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
    action: Action,
  }),
  Schema.Struct({
    origin: Origin,
    target: Target,
    action: Schema.Literal("actions"),
  }),
]);
