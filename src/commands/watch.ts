import { Clock, Deferred, Effect, FileSystem, Path, Schedule } from "effect";
import { check, lock } from "proper-lockfile";
import { RuntimeConfig } from "../config";
import {
  GitHub,
  attention,
  targetKey,
  type Status,
  type Target,
} from "../services/github";
import { Herdr, checkout } from "../services/herdr";
import { Process, ProcessError } from "../services/process";

export const start = Effect.gen(function* () {
  const config = yield* RuntimeConfig;
  const path = yield* Path.Path;
  const herdr = yield* Herdr;
  if (!(yield* herdr.enabled)) return;
  const held = yield* Effect.tryPromise(() =>
    check(path.join(config.state, "watcher"), {
      realpath: false,
      stale: 15_000,
    }),
  );
  if (!held) yield* (yield* Process).detach("watch");
});

type CachedTarget = {
  readonly next: number;
  readonly status: Status | null;
  readonly error: string | null;
};

export const watch = Effect.gen(function* () {
  const config = yield* RuntimeConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const herdr = yield* Herdr;
  const github = yield* GitHub;
  const compromised = yield* Deferred.make<never, ProcessError>();
  const lease = yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      lock(path.join(config.state, "watcher"), {
        realpath: false,
        stale: 15_000,
        update: 5_000,
        onCompromised: (cause) => {
          Deferred.doneUnsafe(
            compromised,
            Effect.fail(
              new ProcessError({ command: "watch", message: String(cause) }),
            ),
          );
        },
      }),
    ).pipe(
      Effect.catch((cause) =>
        Effect.logInfo(`Watcher lease not acquired: ${cause}`).pipe(
          Effect.as(null),
        ),
      ),
    ),
    (release) =>
      release
        ? Effect.tryPromise(() => release()).pipe(
            Effect.catch((cause) => Effect.logWarning(String(cause))),
          )
        : Effect.void,
  );
  if (!lease) return;
  yield* Effect.logInfo("Workflow watcher started");
  const workspaces = new Map<string, string>();
  const cached = new Map<string, CachedTarget>();
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      [...workspaces.keys()],
      (id) =>
        herdr
          .metadata(id, null)
          .pipe(Effect.catch((cause) => Effect.logDebug(String(cause)))),
      { concurrency: config.concurrency, discard: true },
    ),
  );

  const refresh = Effect.gen(function* () {
    const snapshot = yield* herdr.snapshot;
    const discovered = yield* Effect.forEach(
      snapshot.workspaces,
      Effect.fn("Watch.discover")(function* (workspace) {
        const cwd = checkout(workspace, snapshot.panes);
        const result = cwd
          ? yield* github.discover(cwd).pipe(Effect.result)
          : null;
        const target = result?._tag === "Success" ? result.success : null;
        const error =
          result?._tag === "Failure" ? String(result.failure) : null;
        const key = target ? targetKey(target) : "";
        if (workspaces.get(workspace.workspace_id) !== key)
          yield* herdr.metadata(workspace.workspace_id, null);
        workspaces.set(workspace.workspace_id, key);
        return { id: workspace.workspace_id, target, error };
      }),
      { concurrency: config.concurrency },
    );
    const targets = new Map<string, Target>();
    for (const item of discovered)
      if (item.target) targets.set(targetKey(item.target), item.target);
    for (const key of cached.keys()) if (!targets.has(key)) cached.delete(key);
    for (const id of workspaces.keys())
      if (
        !snapshot.workspaces.some((workspace) => workspace.workspace_id === id)
      )
        workspaces.delete(id);
    yield* Effect.forEach(
      [...targets],
      Effect.fn("Watch.poll")(function* ([key, target]) {
        const now = yield* Clock.currentTimeMillis;
        const previous = cached.get(key);
        if (previous && now < previous.next) return;
        const result = yield* github.status(target).pipe(Effect.result);
        const finished = yield* Clock.currentTimeMillis;
        if (result._tag === "Failure") {
          yield* Effect.logWarning(
            `${target.repository} ${target.branch}: ${result.failure}`,
          );
          cached.set(key, {
            next: finished + config.retryMs,
            status: null,
            error: String(result.failure),
          });
        } else {
          cached.set(key, {
            next: finished + config.pollMs,
            status: result.success,
            error: null,
          });
        }
      }),
      { concurrency: config.concurrency, discard: true },
    );
    const entries = yield* Effect.forEach(
      discovered,
      Effect.fn("Watch.publish")(function* (item) {
        const value = item.target
          ? cached.get(targetKey(item.target))
          : undefined;
        const error = item.error ?? value?.error ?? null;
        const failures =
          value?.status?.runs.filter((run) => attention(run.conclusion)) ?? [];
        const success =
          config.showSuccess &&
          value?.status?.runs.some((run) => run.conclusion === "success") &&
          value.status.runs.every(
            (run) =>
              run.status === "completed" &&
              (run.conclusion === "success" ||
                run.conclusion === "neutral" ||
                run.conclusion === "skipped"),
          );
        yield* herdr.metadata(
          item.id,
          error
            ? "CI ?"
            : failures.length
              ? `CI !${failures.length}`
              : success
                ? "CI: ✓"
                : null,
        );
        return {
          workspace: item.id,
          target: item.target,
          status: value?.status ?? null,
          error,
        };
      }),
      { concurrency: config.concurrency },
    );
    const file = path.join(config.state, "status.json");
    yield* fs.writeFileString(
      `${file}.tmp`,
      JSON.stringify(
        { updated: yield* Clock.currentTimeMillis, workspaces: entries },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    yield* fs.rename(`${file}.tmp`, file);
  });

  yield* Effect.gen(function* () {
    while (
      yield* herdr.enabled.pipe(
        Effect.retry({ times: 5, schedule: Schedule.spaced(1_000) }),
      )
    ) {
      yield* refresh.pipe(
        Effect.retry({ times: 5, schedule: Schedule.spaced(1_000) }),
      );
      yield* Effect.sleep(config.pollMs);
    }
    yield* Effect.logInfo("Workflow watcher disabled");
  }).pipe(Effect.raceFirst(Deferred.await(compromised)));
}).pipe(Effect.scoped);
