import { createHash } from "node:crypto";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";

export const pluginId = "timmo.workflow-watch";
export const token = "timmo_workflow_watch";

export class ConfigError extends Schema.TaggedError<ConfigError>()(
  "ConfigError",
  {
    message: Schema.String,
  },
) {}

const Text = Schema.String.check(Schema.isMinLength(1));
const Settings = Schema.Struct({
  pollSeconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 3600 })),
  ),
  retrySeconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 30, maximum: 3600 })),
  ),
  timeoutSeconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 120 })),
  ),
  concurrency: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
  ),
  launcher: Schema.optionalKey(
    Schema.Struct({
      argv: Schema.NonEmptyArray(Text),
      agent: Text,
      verifyCommand: Schema.NonEmptyArray(Text),
    }),
  ),
});

const Environment = Schema.Struct({
  HERDR_SOCKET_PATH: Text,
  HERDR_PLUGIN_ROOT: Text,
  HERDR_PLUGIN_CONFIG_DIR: Text,
  HERDR_PLUGIN_STATE_DIR: Text,
});

export class RuntimeConfig extends Context.Service<
  RuntimeConfig,
  {
    readonly socket: string;
    readonly root: string;
    readonly state: string;
    readonly pollMs: number;
    readonly retryMs: number;
    readonly timeoutMs: number;
    readonly concurrency: number;
    readonly launcher: typeof Settings.Type.launcher;
  }
>()("herdr-workflow-watch/Config") {
  static readonly layer = Layer.effect(
    RuntimeConfig,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const env = yield* Schema.decodeUnknownEffect(Environment)(process.env);
      const file = path.join(env.HERDR_PLUGIN_CONFIG_DIR, "config.json");
      const settings = yield* Schema.decodeEffect(
        Schema.fromJsonString(Settings),
      )((yield* fs.exists(file)) ? yield* fs.readFileString(file) : "{}");
      const state = path.join(
        env.HERDR_PLUGIN_STATE_DIR,
        createHash("sha256")
          .update(env.HERDR_SOCKET_PATH)
          .digest("hex")
          .slice(0, 20),
      );
      yield* fs.makeDirectory(state, { recursive: true, mode: 0o700 });
      return RuntimeConfig.of({
        socket: env.HERDR_SOCKET_PATH,
        root: env.HERDR_PLUGIN_ROOT,
        state,
        pollMs: (settings.pollSeconds ?? 30) * 1000,
        retryMs:
          Math.max(settings.retrySeconds ?? 120, settings.pollSeconds ?? 30) *
          1000,
        timeoutMs: (settings.timeoutSeconds ?? 30) * 1000,
        concurrency: settings.concurrency ?? 3,
        launcher: settings.launcher,
      });
    }).pipe(
      Effect.mapError((cause) => new ConfigError({ message: String(cause) })),
    ),
  );
}
