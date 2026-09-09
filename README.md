# Herdr Workflow Watch

GitHub workflow failure indicators for Herdr workspaces.

Watches the current branch of every open GitHub-backed workspace. `CI: !2` means
two workflow runs need attention; `CI: ?` means GitHub or repository state could
not be read. Healthy workspaces have no indicator by default; enable `showSuccess`
to display `CI: ✓` when CI has passed. Ineligible workspaces have no indicator.

The watcher resolves the latest pushed commit from GitHub on each poll, including
all actors and events. Local unpushed commits do not hide its failures. Failed,
timed-out, startup-failed and action-required runs need attention; cancelled,
neutral and skipped runs do not. Reruns replace the previous attempt's result.

## Install

Requires Herdr 0.9.0 or newer, Git, authenticated [GitHub CLI](https://cli.github.com/)
and [mise](https://mise.jdx.dev/) with the toolchain from `mise.toml` installed.
The plugin uses your existing `gh` authentication.

```sh
herdr plugin install timmo001/herdr-workflow-watch
herdr plugin action invoke timmo.workflow-watch.start
herdr plugin config-dir timmo.workflow-watch
```

For a local checkout, run `mise run install` and `mise run build`, then
`herdr plugin link .` and invoke the start action. Linking and reloading do not
run startup hooks. Rebuild before starting a new watcher after source changes.

Add the token to your existing Space rows and bind the picker in Herdr's config:

```toml
[ui.sidebar.spaces]
rows = [
  ["state_icon", "workspace"],
  ["branch", "git_status", { token = "$timmo_workflow_watch", fg = "#f38ba8", dim = false, rules = [{ equals = "CI: ?", fg = "#f9e2af" }, { equals = "CI: ✓", fg = "#a6e3a1" }] }],
]

[[keys.command]]
key = "prefix+f"
type = "plugin_action"
command = "timmo.workflow-watch.open"
description = "open workflow failures"
```

Reload with `herdr server reload-config`.
The indicator uses red for failures, amber for unavailable status and green for
success. Herdr's sidebar colours must use hex values.

## Actions

Choose **Open all Actions in browser** in the first menu to open the repository's
`/actions` page, including when there are no failures.

Open `timmo.workflow-watch.open` to pick a failure and then:

- **Open failure in browser:** opens the selected run through `gh`.
- **Paste draft into original agent:** inserts the failure at the cursor without
  clearing existing input or submitting it. Available only while that same agent
  is ready, with no approval or question prompt.
- **New agent in this checkout:** asks which agent to launch, creates a pane in
  the originating workspace and submits an investigation/fix prompt.
- **New agent in a new worktree:** asks which agent to launch, creates a unique
  fix branch from the selected pushed commit, opens its Herdr worktree and
  submits the prompt there.

Prompts include repository, branch, SHA, run and job IDs, attempt, URL and failed
steps. Large logs are saved to a local file referenced by the prompt. Terminal
control sequences are removed. A changed branch, run or agent requires reopening
the picker. New-agent prompts ask for uncommitted, unpushed fixes.

## Configuration and state

Create `config.json` in the directory printed by `herdr plugin config-dir`:

```json
{
  "pollSeconds": 30,
  "retrySeconds": 120,
  "timeoutSeconds": 30,
  "concurrency": 3,
  "showSuccess": true,
  "indicatorTemplates": {
    "failure": "CI: !{count}",
    "unavailable": "CI: ?",
    "success": "CI: ✓"
  },
  "launchers": [
    {
      "id": "custom-opencode",
      "label": "Custom OpenCode",
      "argv": ["/path/to/agent-launcher"],
      "agent": "opencode",
      "verifyCommand": ["/path/to/resolve-agent-executable"]
    },
    {
      "id": "pi",
      "label": "Pi",
      "argv": ["pi"],
      "agent": "pi"
    }
  ]
}
```

`showSuccess` defaults to `false`. Set it to `true` to show `CI: ✓` when at least
one run succeeds and all runs have completed with success, neutral or skipped
conclusions. Pending, cancelled and empty run lists do not show a checkmark.

`indicatorTemplates` controls each indicator's full text, including icons,
spacing and punctuation. Omitted entries use the defaults shown above. Templates
must be non-empty; every `{count}` in `failure` is replaced with the number of
runs needing attention. `unavailable` and `success` are literal text.

For compact icons, use:

```json
{
  "indicatorTemplates": {
    "failure": "⚡!{count}",
    "unavailable": "⚡?",
    "success": "⚡✓"
  }
}
```

Update the sidebar colour rules' `equals` values to match your templates, such
as `"⚡?"` and `"⚡✓"`. The success template still requires `showSuccess: true`.

Omit `launchers` to use the built-in choices: OpenCode, Pi, Cursor Agent, Claude
Code, Codex, GitHub Copilot, OMP, Devin, Droid, Kimi, Kilo, Hermes, Qoder CLI,
Qwen, Mastra Code, Antigravity CLI and Grok. A configured array replaces the
defaults; `"launchers": []` disables new-agent actions.

Only launchers with an installed Herdr integration (`current` or `outdated`) and
an executable command appear. The agent does not need to be running already.
If none are available, both new-agent actions are disabled.

Each launcher has a unique `id`, a display `label`, an `argv` command and Herdr's
detected `agent` name. `argv[0]` can be an executable path or a command resolved
through Bash's login environment. Arguments are shell-quoted. `integration`
optionally overrides the integration name checked for availability; it defaults
to `agent` (Antigravity CLI uses integration `antigravity-cli` and agent `agy`).

For wrappers or multiple versions of the same agent, set `verifyCommand` to print
the single absolute executable path expected in the new pane's foreground argv.
The plugin checks that process before submitting work. All launches wait for
Herdr to detect the selected agent as ready. Changing or removing the selected
launcher requires reopening the picker.

Keep personal launcher settings in your own config, outside the plugin checkout.

Polls are bounded to 10-3600 seconds, retries to 30-3600 seconds, command timeouts
to 5-120 seconds and concurrency to 1-8. Retries are never faster than polling.
Restart the watcher to apply configuration changes: disable the plugin, wait for
the watcher lease to disappear, enable it and invoke the start action.

The plugin uses `HERDR_PLUGIN_CONFIG_DIR` for configuration and a socket-specific
directory under `HERDR_PLUGIN_STATE_DIR` for its lease, `watch.log`, `dispatch.log`,
`status.json` and saved failure output. There is one watcher per server socket;
workspaces sharing a repository and remote branch share GitHub requests. Startup
and workspace hooks start it idempotently. It exits after the plugin is disabled
or the session becomes unavailable, and indicators have a TTL.

Discovery prefers an attached worktree, then the workspace or pane directory.
It watches the configured GitHub upstream, falling back to GitHub origin.
Detached checkouts, missing remote branches, non-Git directories and non-GitHub
remotes are skipped. Incomplete or failed GitHub requests show unavailable state.

Use `herdr plugin list --plugin timmo.workflow-watch --json` and
`herdr plugin log list --plugin timmo.workflow-watch` for registration and hook
diagnostics. The socket-specific logs contain watcher and action details.

## Development

[mise](https://mise.jdx.dev/) pins Bun and Node and runs the project tasks.

```sh
mise install
mise run install
mise run check
mise run build
bun dist/index.js --help
```

Use `mise run format` to format source and configuration.
CI installs dependencies with `bun install --frozen-lockfile`. Build, lint and
the CLI smoke check run independently. Build output is a Bun module in `dist/`.
Validation is lint, strict types, formatting, build, CLI help and local plugin
registration/startup. Interactive behaviour is tested manually.
