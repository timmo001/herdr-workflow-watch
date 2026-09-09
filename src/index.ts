import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { version } from "../package.json";

Command.make("herdr-workflow-watch").pipe(
  Command.withDescription(
    "GitHub workflow failure indicators for Herdr workspaces",
  ),
  Command.run({ version }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
