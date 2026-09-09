import { HerdrSdk, type WorkspaceId } from "@herdr/sdk";
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  FileSystem,
  Path,
  Schedule,
} from "effect";
import { check, lock } from "proper-lockfile";
import { RuntimeConfig } from "../config";
import { reportError } from "../errors";
import {
  GitHub,
  attention,
  targetKey,
  type Status,
  type Target,
} from "../services/github";
import { checkout, enabled, metadata } from "../services/herdr";
import { Process, ProcessError } from "../services/process";
import { waitForUpdate } from "../services/reload";

export const start = Effect.gen(function* () {
  const config = yield* RuntimeConfig;
  const path = yield* Path.Path;
  if (!(yield* enabled)) return;
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

const runWatcher = Effect.gen(function* () {
  const config = yield* RuntimeConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const herdr = yield* HerdrSdk;
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
        Effect.logInfo("Watcher lease not acquired", cause).pipe(
          Effect.as(null),
        ),
      ),
    ),
    (release) =>
      release
        ? Effect.tryPromise(() => release()).pipe(
            Effect.catch((cause) =>
              Effect.die(
                new ProcessError({
                  command: "watch",
                  message: `Could not release watcher lease: ${String(cause)}`,
                }),
              ),
            ),
          )
        : Effect.void,
  );
  if (!lease) return false;
  yield* Effect.logInfo("Workflow watcher started");
  const workspaces = new Map<WorkspaceId, string>();
  const discoveryErrors = new Map<WorkspaceId, string>();
  const cached = new Map<string, CachedTarget>();
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      [...workspaces.keys()],
      (id) =>
        metadata(id, null).pipe(
          Effect.catch((cause) =>
            Effect.logDebug("Could not clear workspace indicator", cause),
          ),
        ),
      { concurrency: config.concurrency, discard: true },
    ),
  );

  const refresh = Effect.gen(function* () {
    const snapshot = yield* herdr.session.snapshot();
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
        if (error && result?._tag === "Failure") {
          if (discoveryErrors.get(workspace.id) !== error)
            yield* reportError(
              Cause.fail(result.failure),
              "Could not inspect workspace",
            ).pipe(Effect.annotateLogs({ workspace: workspace.id }));
          discoveryErrors.set(workspace.id, error);
        } else {
          discoveryErrors.delete(workspace.id);
        }
        const key = target ? targetKey(target) : "";
        if (workspaces.get(workspace.id) !== key)
          yield* metadata(workspace.id, null);
        workspaces.set(workspace.id, key);
        return { id: workspace.id, target, error };
      }),
      { concurrency: config.concurrency },
    );
    const targets = new Map<string, Target>();
    for (const item of discovered)
      if (item.target) targets.set(targetKey(item.target), item.target);
    for (const key of cached.keys()) if (!targets.has(key)) cached.delete(key);
    for (const id of workspaces.keys())
      if (!snapshot.workspaces.some((workspace) => workspace.id === id)) {
        workspaces.delete(id);
        discoveryErrors.delete(id);
      }
    yield* Effect.forEach(
      [...targets],
      Effect.fn("Watch.poll")(function* ([key, target]) {
        const now = yield* Clock.currentTimeMillis;
        const previous = cached.get(key);
        if (previous && now < previous.next) return;
        const result = yield* github.status(target).pipe(Effect.result);
        const finished = yield* Clock.currentTimeMillis;
        if (result._tag === "Failure") {
          if (previous?.error !== String(result.failure))
            yield* reportError(
              Cause.fail(result.failure),
              "GitHub Actions unavailable",
            ).pipe(
              Effect.annotateLogs({
                repository: target.repository,
                branch: target.branch,
              }),
            );
          else
            yield* Effect.logWarning(
              `${target.repository} ${target.branch}: GitHub polling still unavailable`,
              result.failure,
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
        yield* metadata(
          item.id,
          error
            ? config.indicatorTemplates.unavailable
            : failures.length
              ? config.indicatorTemplates.failure.replaceAll(
                  "{count}",
                  String(failures.length),
                )
              : success
                ? config.indicatorTemplates.success
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

  return yield* Effect.gen(function* () {
    while (
      yield* enabled.pipe(
        Effect.retry({ times: 5, schedule: Schedule.spaced(1_000) }),
      )
    ) {
      yield* refresh.pipe(
        Effect.retry({ times: 5, schedule: Schedule.spaced(1_000) }),
      );
      yield* Effect.sleep(config.pollMs);
    }
    yield* Effect.logInfo("Workflow watcher disabled");
    return false;
  }).pipe(
    Effect.raceFirst(waitForUpdate.pipe(Effect.as(true))),
    Effect.raceFirst(Deferred.await(compromised)),
  );
}).pipe(Effect.scoped);

export const watch = Effect.gen(function* () {
  const restart = yield* runWatcher;
  if (restart && (yield* enabled)) {
    yield* Effect.logInfo("Workflow Watch changed; starting a new watcher");
    yield* (yield* Process).detach("watch");
  }
});
