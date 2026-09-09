import { createConnection } from "node:net";
import { Context, Effect, Layer, Schema } from "effect";
import { RuntimeConfig, pluginId, token } from "../config";

export class HerdrError extends Schema.TaggedError<HerdrError>()("HerdrError", {
  code: Schema.String,
  message: Schema.String,
}) {}

const OptionalText = Schema.optionalKey(Schema.NullOr(Schema.String));
export const Pane = Schema.Struct({
  pane_id: Schema.String,
  workspace_id: Schema.String,
  terminal_id: Schema.String,
  cwd: OptionalText,
  foreground_cwd: OptionalText,
  agent: OptionalText,
  agent_status: Schema.String,
  agent_session: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ value: Schema.String })),
  ),
});
export const Workspace = Schema.Struct({
  workspace_id: Schema.String,
  cwd: OptionalText,
  worktree: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ checkout_path: Schema.String })),
  ),
});
const Snapshot = Schema.Struct({
  workspaces: Schema.Array(Workspace),
  panes: Schema.Array(Pane),
});
const ProcessInfo = Schema.Struct({
  foreground_processes: Schema.Array(
    Schema.Struct({
      pid: Schema.Int,
      argv: Schema.Array(Schema.String),
    }),
  ),
});
export const Origin = Schema.Struct({
  workspace: Schema.String,
  pane: Pane,
  processes: ProcessInfo.fields.foreground_processes,
});
export type Origin = typeof Origin.Type;

type Requests = {
  "session.snapshot": Record<string, never>;
  "plugin.list": { plugin_id: string };
  "pane.get": { pane_id: string };
  "pane.process_info": { pane_id: string };
  "agent.get": { target: string };
  "agent.prompt": { target: string; text: string };
  "popup.close": Record<string, never>;
  "notification.show": { title: string; body: string };
  "worktree.create": {
    cwd: string;
    branch: string;
    base: string;
    label: string;
    focus: boolean;
  };
  "pane.split": {
    target_pane_id: string;
    workspace_id: string;
    direction: "down" | "right";
    cwd: string;
    focus: boolean;
  };
  "plugin.pane.open": {
    plugin_id: string;
    entrypoint: string;
    placement: "popup";
    focus: boolean;
    env: Record<string, string>;
  };
  "workspace.report_metadata": {
    workspace_id: string;
    source: string;
    tokens: Record<string, string | null>;
    ttl_ms: number;
  };
};

export class Herdr extends Context.Service<
  Herdr,
  {
    readonly request: <K extends keyof Requests, A>(
      method: K,
      params: Requests[K],
      schema: Schema.Codec<A, unknown>,
    ) => Effect.Effect<A, HerdrError>;
    readonly snapshot: Effect.Effect<typeof Snapshot.Type, HerdrError>;
    readonly enabled: Effect.Effect<boolean, HerdrError>;
    readonly pane: (id: string) => Effect.Effect<typeof Pane.Type, HerdrError>;
    readonly processes: (
      id: string,
    ) => Effect.Effect<
      typeof ProcessInfo.Type.foreground_processes,
      HerdrError
    >;
    readonly metadata: (
      id: string,
      value: string | null,
    ) => Effect.Effect<void, HerdrError>;
  }
>()("herdr-workflow-watch/Herdr") {
  static readonly layer = Layer.effect(
    Herdr,
    Effect.gen(function* () {
      const config = yield* RuntimeConfig;
      const request = Effect.fn("Herdr.request")(
        function* <K extends keyof Requests, A>(
          method: K,
          params: Requests[K],
          schema: Schema.Codec<A, unknown>,
        ) {
          const line = yield* Effect.callback<string, HerdrError>((resume) => {
            const socket = createConnection(config.socket);
            let buffer = "";
            socket.setEncoding("utf8");
            socket.once("connect", () =>
              socket.write(
                `${JSON.stringify({ id: pluginId, method, params })}\n`,
              ),
            );
            socket.on("data", (chunk) => {
              buffer += chunk;
              const end = buffer.indexOf("\n");
              if (end >= 0) resume(Effect.succeed(buffer.slice(0, end)));
            });
            socket.once("error", (cause) =>
              resume(
                Effect.fail(
                  new HerdrError({ code: "transport", message: String(cause) }),
                ),
              ),
            );
            socket.once("end", () =>
              resume(
                Effect.fail(
                  new HerdrError({
                    code: "transport",
                    message: "Herdr closed the connection",
                  }),
                ),
              ),
            );
            return Effect.sync(() => {
              socket.destroy();
            });
          }).pipe(Effect.timeout(config.timeoutMs));
          const response = yield* Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Union([
                Schema.Struct({ result: schema }),
                Schema.Struct({
                  error: Schema.Struct({
                    code: Schema.String,
                    message: Schema.String,
                  }),
                }),
              ]),
            ),
          )(line);
          if ("error" in response) return yield* new HerdrError(response.error);
          return response.result;
        },
        (effect) =>
          effect.pipe(
            Effect.mapError((cause) =>
              cause instanceof HerdrError
                ? cause
                : new HerdrError({ code: "response", message: String(cause) }),
            ),
          ),
      );
      const snapshot = request(
        "session.snapshot",
        {},
        Schema.Struct({ snapshot: Snapshot }),
      ).pipe(Effect.map((value) => value.snapshot));
      const enabled = request(
        "plugin.list",
        { plugin_id: pluginId },
        Schema.Struct({
          plugins: Schema.Array(
            Schema.Struct({
              plugin_id: Schema.String,
              enabled: Schema.Boolean,
            }),
          ),
        }),
      ).pipe(
        Effect.map((value) =>
          value.plugins.some(
            (plugin) => plugin.plugin_id === pluginId && plugin.enabled,
          ),
        ),
      );
      const pane = Effect.fn("Herdr.pane")(function* (id: string) {
        return (yield* request(
          "pane.get",
          { pane_id: id },
          Schema.Struct({ pane: Pane }),
        )).pane;
      });
      const processes = Effect.fn("Herdr.processes")(function* (id: string) {
        return (yield* request(
          "pane.process_info",
          { pane_id: id },
          Schema.Struct({ process_info: ProcessInfo }),
        )).process_info.foreground_processes;
      });
      const metadata = Effect.fn("Herdr.metadata")(function* (
        id: string,
        value: string | null,
      ) {
        yield* request(
          "workspace.report_metadata",
          {
            workspace_id: id,
            source: `plugin:${pluginId}`,
            tokens: { [token]: value },
            ttl_ms: Math.min(86_400_000, config.retryMs + config.pollMs * 2),
          },
          Schema.Unknown,
        );
      });
      return Herdr.of({
        request,
        snapshot,
        enabled,
        pane,
        processes,
        metadata,
      });
    }),
  );
}

export function checkout(
  workspace: typeof Workspace.Type,
  panes: ReadonlyArray<typeof Pane.Type>,
) {
  return (
    workspace.worktree?.checkout_path ??
    workspace.cwd ??
    panes.find((pane) => pane.workspace_id === workspace.workspace_id)?.cwd
  );
}
