import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { version } from "../package.json";
import { dispatch } from "./Actions";
import { RuntimeConfig } from "./Config";
import { GitHub } from "./GitHub";
import { Herdr } from "./Herdr";
import { open, picker } from "./Picker";
import { Process } from "./Process";
import { start, watch } from "./Watch";

const platform = RuntimeConfig.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
);
const services = Layer.merge(Process.layer, Herdr.layer).pipe(
  Layer.provideMerge(platform),
);
const application = GitHub.layer.pipe(Layer.provideMerge(services));

Command.make("herdr-workflow-watch").pipe(
  Command.withDescription(
    "GitHub workflow failure indicators for Herdr workspaces",
  ),
  Command.withSubcommands([
    Command.make("start", {}, () => start.pipe(Effect.provide(application))),
    Command.make("watch", {}, () => watch.pipe(Effect.provide(application))),
    Command.make("open", {}, () => open.pipe(Effect.provide(application))),
    Command.make("picker", {}, () => picker.pipe(Effect.provide(application))),
    Command.make("dispatch", {}, () =>
      dispatch.pipe(Effect.provide(application)),
    ),
  ]),
  Command.run({ version }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
