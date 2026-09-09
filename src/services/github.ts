import { Api, Gh } from "@timmo001/effect-gh";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { Process } from "./process";

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
      const gh = yield* Gh;

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

      const status = Effect.fn("GitHub.status")(
        function* (target: Target) {
          const refs = yield* Api.json(
            {
              endpoint: `repos/${target.repository}/git/matching-refs/heads/${encodeURIComponent(target.branch)}`,
              method: "GET",
              hostname: "github.com",
            },
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
          const pages = yield* Api.pages(
            {
              endpoint: `repos/${target.repository}/actions/runs`,
              method: "GET",
              hostname: "github.com",
              query: {
                branch: target.branch,
                head_sha: ref.object.sha,
                per_page: 100,
              },
            },
            Schema.Struct({
              total_count: Schema.Int,
              workflow_runs: Schema.Array(Run),
            }),
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
        },
        (effect) =>
          effect.pipe(
            Effect.provideService(Gh, gh),
            Effect.mapError((cause) =>
              cause instanceof GitHubError
                ? cause
                : new GitHubError({ message: String(cause) }),
            ),
          ),
      );

      const details = Effect.fn("GitHub.details")(
        function* (target: Target, run: Run) {
          const pages = yield* Api.pages(
            {
              endpoint: `repos/${target.repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
              method: "GET",
              hostname: "github.com",
              query: { per_page: 100 },
            },
            Schema.Struct({ jobs: Schema.Array(Job) }),
          );
          const jobs = pages
            .flatMap((page) => page.jobs)
            .filter((job) => attention(job.conclusion));
          let stderr = "";
          const logs = yield* gh
            .stream([
              "run",
              "view",
              String(run.id),
              "--repo",
              `github.com/${target.repository}`,
              "--attempt",
              String(run.run_attempt),
              "--log-failed",
            ])
            .pipe(
              Stream.map((chunk) => {
                if (chunk._tag === "Stderr") {
                  stderr += chunk.text;
                  return "";
                }
                return chunk.text;
              }),
              Stream.mkString,
              Effect.map((stdout) => stdout.trim()),
              Effect.catchTag("GhCommandError", () =>
                Effect.succeed(
                  `Failed-step output unavailable: ${stderr.trim()}`,
                ),
              ),
            );
          return {
            jobs,
            logs,
          };
        },
        (effect) =>
          effect.pipe(
            Effect.provideService(Gh, gh),
            Effect.mapError(
              (cause) => new GitHubError({ message: String(cause) }),
            ),
          ),
      );
      return GitHub.of({ discover, status, details });
    }),
  );
}
