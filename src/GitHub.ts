import { Context, Effect, Layer, Schema } from "effect";
import { Process } from "./Process";

export class GitHubError extends Schema.TaggedError<GitHubError>()(
  "GitHubError",
  {
    message: Schema.String,
  },
) {}

export const Target = Schema.Struct({
  root: Schema.String,
  remote: Schema.String,
  repository: Schema.String,
  branch: Schema.String,
  localBranch: Schema.String,
});
export type Target = typeof Target.Type;
const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));
export const Run = Schema.Struct({
  id: Schema.Int,
  run_attempt: Schema.Int,
  name: Schema.NullOr(Schema.String),
  display_title: Schema.String,
  head_branch: Schema.NullOr(Schema.String),
  head_sha: Sha,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  html_url: Schema.String,
});
export type Run = typeof Run.Type;
export const Status = Schema.Struct({ sha: Sha, runs: Schema.Array(Run) });
export type Status = typeof Status.Type;
const Job = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  steps: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        number: Schema.Int,
        name: Schema.String,
        conclusion: Schema.NullOr(Schema.String),
      }),
    ),
  ),
});

export function attention(conclusion: string | null) {
  return (
    conclusion !== null &&
    ["failure", "timed_out", "startup_failure", "action_required"].includes(
      conclusion,
    )
  );
}

export function targetKey(target: Target) {
  return `${target.repository.toLowerCase()}#${target.branch}`;
}

export class GitHub extends Context.Service<
  GitHub,
  {
    readonly discover: (
      cwd: string,
    ) => Effect.Effect<Target | null, GitHubError>;
    readonly status: (
      target: Target,
    ) => Effect.Effect<Status | null, GitHubError>;
    readonly details: (
      target: Target,
      run: Run,
    ) => Effect.Effect<
      { readonly jobs: ReadonlyArray<typeof Job.Type>; readonly logs: string },
      GitHubError
    >;
  }
>()("herdr-workflow-watch/GitHub") {
  static readonly layer = Layer.effect(
    GitHub,
    Effect.gen(function* () {
      const process = yield* Process;
      const api = Effect.fn("GitHub.api")(
        function* <A>(
          endpoint: string,
          schema: Schema.Codec<A, unknown>,
          paginate = false,
        ) {
          return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(
            yield* process.text("gh", [
              "api",
              "--hostname",
              "github.com",
              endpoint,
              ...(paginate ? ["--paginate", "--slurp"] : []),
            ]),
          );
        },
        (effect) =>
          effect.pipe(
            Effect.mapError(
              (cause) => new GitHubError({ message: String(cause) }),
            ),
          ),
      );

      const discover = Effect.fn("GitHub.discover")(
        function* (cwd: string) {
          const root = yield* process.run(
            "git",
            ["rev-parse", "--show-toplevel"],
            cwd,
          );
          if (root.code !== 0) {
            if (root.stderr.includes("not a git repository")) return null;
            return yield* new GitHubError({ message: root.stderr });
          }
          const branch = yield* process.run(
            "git",
            ["symbolic-ref", "--quiet", "--short", "HEAD"],
            root.stdout,
          );
          if (branch.code === 1) return null;
          if (branch.code !== 0)
            return yield* new GitHubError({ message: branch.stderr });
          const upstream = yield* process.run(
            "git",
            ["config", "--get", `branch.${branch.stdout}.remote`],
            root.stdout,
          );
          const merge = yield* process.run(
            "git",
            ["config", "--get", `branch.${branch.stdout}.merge`],
            root.stdout,
          );
          if (upstream.code > 1 || merge.code > 1)
            return yield* new GitHubError({
              message: upstream.stderr || merge.stderr,
            });
          const remotes = (yield* process.text(
            "git",
            ["remote"],
            root.stdout,
          )).split("\n");
          const candidates = [...new Set([upstream.stdout, "origin"])];
          for (const remote of candidates) {
            if (!remote || !remotes.includes(remote)) continue;
            const url = yield* process.text(
              "git",
              ["remote", "get-url", remote],
              root.stdout,
            );
            const match =
              /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)\/?$/.exec(
                url.replace(/\.git\/?$/, ""),
              );
            if (!match?.[1]) continue;
            return {
              root: root.stdout,
              remote,
              repository: match[1],
              localBranch: branch.stdout,
              branch:
                remote === upstream.stdout &&
                merge.stdout.startsWith("refs/heads/")
                  ? merge.stdout.slice(11)
                  : branch.stdout,
            };
          }
          return null;
        },
        (effect) =>
          effect.pipe(
            Effect.mapError(
              (cause) => new GitHubError({ message: String(cause) }),
            ),
          ),
      );

      const status = Effect.fn("GitHub.status")(function* (target: Target) {
        const refs = yield* api(
          `repos/${target.repository}/git/matching-refs/heads/${encodeURIComponent(target.branch)}`,
          Schema.Array(
            Schema.Struct({
              ref: Schema.String,
              object: Schema.Struct({ sha: Sha }),
            }),
          ),
        );
        const ref = refs.find(
          (value) => value.ref === `refs/heads/${target.branch}`,
        );
        if (!ref) return null;
        const pages = yield* api(
          `repos/${target.repository}/actions/runs?branch=${encodeURIComponent(target.branch)}&head_sha=${ref.object.sha}&per_page=100`,
          Schema.Array(
            Schema.Struct({
              total_count: Schema.Int,
              workflow_runs: Schema.Array(Run),
            }),
          ),
          true,
        );
        const attempts = new Map<number, Run>();
        for (const page of pages) {
          for (const run of page.workflow_runs) {
            if ((attempts.get(run.id)?.run_attempt ?? 0) <= run.run_attempt)
              attempts.set(run.id, run);
          }
        }
        if (pages.some((page) => page.total_count > attempts.size))
          return yield* new GitHubError({
            message: "GitHub returned an incomplete workflow run list",
          });
        return {
          sha: ref.object.sha,
          runs: [...attempts.values()].filter(
            (run) =>
              run.head_sha === ref.object.sha &&
              run.head_branch === target.branch,
          ),
        };
      });

      const details = Effect.fn("GitHub.details")(
        function* (target: Target, run: Run) {
          const pages = yield* api(
            `repos/${target.repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
            Schema.Array(Schema.Struct({ jobs: Schema.Array(Job) })),
            true,
          );
          const jobs = pages
            .flatMap((page) => page.jobs)
            .filter((job) => attention(job.conclusion));
          const logs = yield* process.run("gh", [
            "run",
            "view",
            String(run.id),
            "--repo",
            `github.com/${target.repository}`,
            "--attempt",
            String(run.run_attempt),
            "--log-failed",
          ]);
          return {
            jobs,
            logs:
              logs.code === 0
                ? logs.stdout
                : `Failed-step output unavailable: ${logs.stderr}`,
          };
        },
        (effect) =>
          effect.pipe(
            Effect.mapError(
              (cause) => new GitHubError({ message: String(cause) }),
            ),
          ),
      );
      return GitHub.of({ discover, status, details });
    }),
  );
}
