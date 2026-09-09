# GitHub PR Status — PI WEB plugin

PI WEB plugin that brings Claude Code–style pull request awareness to your workspaces:

- **PR number + link** for the workspace branch when an open PR exists.
- **CI ball**: 🟢 passing · 🟠 running · 🔴 failing · **no ball** when the PR has no CI.
- **Worktree state at a glance**: ✎ uncommitted changes, ↑ unpushed commits, ↓ behind upstream.
- **Pull Request panel** with check details and **one-click merge / close without opening GitHub**.
- **Merge guardrails** (all configurable):
  - refuses to merge when the worktree is dirty (uncommitted or untracked files);
  - refuses to merge when local commits were not pushed (or the branch has no upstream);
  - asks for explicit confirmation before merging with CI running (orange) or failing (red) — never when CI is green or absent.

Works on local and federated remote machines: all commands run through the workspace's own terminal helpers with the machine's `git` and `gh` CLI.

## Requirements

- PI WEB (browser plugin API v2 — no session-daemon restart needed, browser-only plugin).
- `git` on the workspace machine (already required by PI WEB's Git panel).
- [`gh` CLI](https://cli.github.com) **installed and authenticated** (`gh auth login`) for PR/CI data, merge and close. Without it the plugin degrades gracefully: you still get worktree dirty/push state, and the panel explains what is missing.
- A POSIX shell (`sh`) on the workspace machine (Linux/macOS; WSL works, native Windows shells are not supported yet).

## Install

### From npm (recommended)

In PI WEB open **Settings → Pi packages** and install:

```text
npm:@gtrabanco/pi-web-github-pr-status
```

Then reload the PI WEB tab. Manage enablement under **Settings → PI WEB plugins** (`github-pr-status`, enabled by default).

### Local development

```bash
git clone https://github.com/gtrabanco/pi-web-github-pr-status.git
cd pi-web-github-pr-status
bun install
bun run build
mkdir -p ~/.pi-web/plugins
ln -s "$(pwd)" ~/.pi-web/plugins/github-pr-status
```

Reload the PI WEB tab after editing (hard reload if the module is cached). Check discovery at `http://127.0.0.1:8504/pi-web-plugins/manifest.json`.

## What you get

| Surface | Content |
| --- | --- |
| Workspace list / panel header / status bar | `#123` (link to the PR) · CI ball (link) · `✎n` dirty marker · `↑n` / `↓n` push state |
| **Pull Request** workspace tab | PR card (title, state, author, branch, conflicts, review), CI check list, worktree summary, **Merge** / **Close PR** buttons, inline settings editor |
| Action palette | Open Pull Request panel · Refresh GitHub PR status · Open pull request on GitHub |

### Merge guardrails

Pressing **Merge** (default `gh pr merge <n> --merge`, non-interactive) is refused when:

- one-click merge is disabled in settings;
- there is no open PR, it is a draft, or GitHub reports merge conflicts;
- the worktree has uncommitted changes (staged, unstaged or untracked) — unless *Require clean worktree* is off;
- local commits were not pushed, or the branch has no upstream.

Pressing **Merge** asks for confirmation when CI is running or failing (only if a CI exists and *Require CI confirmation* is on), when the local branch is behind its upstream, or when GitHub reports a `BLOCKED`/`UNSTABLE` merge state. Green CI or no CI merges immediately.

Closing a PR always asks for confirmation. Both actions run in a visible workspace terminal (`gh pr merge` / `gh pr close`), and the panel surfaces the outcome with a link to the terminal output.

## Configuration

Settings are stored **per workspace** in `.pi-web/github-pr.json` and can be edited from the panel (⚙ Settings → Save) or by hand:

```json
{
  "showCI": true,
  "refreshSeconds": 90,
  "adaptiveRefresh": true,
  "merge": {
    "enabled": true,
    "method": "merge",
    "requireCleanWorktree": true,
    "requireCI": true,
    "deleteBranch": false
  }
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `showCI` | `true` | Show the CI ball in labels and the CI section in the panel. |
| `refreshSeconds` | `90` | Automatic probe interval while the browser tab is visible (only for the selected workspace). `0` = manual refresh only. Max `3600`. Automatic probes never run more often than every 30 s regardless of this value — see [Performance & reliability](#performance--reliability). |
| `adaptiveRefresh` | `true` | Poll faster while CI needs watching: at most every 30 s while CI is running, every 60 s while CI is failing. |
| `merge.enabled` | `true` | Master switch for one-click merge from the panel. |
| `merge.method` | `"merge"` | `merge`, `squash` or `rebase` (passed to `gh pr merge`). |
| `merge.requireCleanWorktree` | `true` | Block merge when the worktree has uncommitted/untracked changes. |
| `merge.requireCI` | `true` | Require confirmation when CI is running (orange) or failing (red). Only applies when a CI actually exists. |
| `merge.deleteBranch` | `false` | Pass `--delete-branch` to `gh pr merge`. Off by default because it deletes the checked-out local branch. |

Missing or invalid values fall back to defaults with a warning in the panel. Tip: add `.pi-web/` to your `.gitignore` if you do not want settings or probe artifacts tracked — the plugin already excludes its own scratch directory from dirty detection.

## How it works (no magic)

The plugin is **browser-only**. To get machine facts it writes a small POSIX `probe.sh` into `.pi-web/github-pr/`, runs it through the workspace terminal helper, and reads back per-fact files (`branch.txt`, `staged.txt`, `pr.json`, …) written by the script. PR/CI data comes from `gh pr view --json …` using the machine's existing gh auth; worktree facts come from `git`. Nothing leaves the machine except GitHub API calls made by `gh` itself.

Refresh happens when you open the workspace panel, on the configured interval (visible tab only), on palette refresh, and after merge/close actions. Labels for non-selected workspaces show the last data read from disk.

## Performance & reliability

The plugin is deliberately frugal with the one resource it cannot recycle: **workspace terminals**. In PI WEB, every `terminal.runCommand()` creates a terminal that is currently kept forever — server-side records and the Terminal panel's list grow without garbage collection (closing them from a plugin needs [jmfederico/pi-web#225](https://github.com/jmfederico/pi-web/issues/225)). The probe is the only command the plugin runs periodically, so its cadence is bounded:

- **Visible-tab only.** Automatic probes run only while the Pull Request panel is the active tool and the browser tab is visible; hidden tabs probe nothing.
- **30 s automatic floor.** Even with `refreshSeconds` set lower, automatic probes (interval tick, surface invalidation) are spaced at least 30 s apart. The Refresh button always re-probes immediately.
- **Adaptive, not aggressive.** With CI running the interval drops to at most 30 s (60 s while failing) — never the 20 s of older versions, which could leave ~180 terminal records per hour of CI watching.
- **Exponential backoff.** When consecutive probes fail (hung `gh`, network outage, machine asleep) the automatic interval doubles per failure up to 15 minutes, so a broken machine cannot pile up stuck ptys. The panel keeps showing the last error until a probe succeeds; manual Refresh always retries.
- **Cheap invalidations.** Invalidation bursts within the floor re-read the probe's scratch files instead of spawning new terminals, and the probe script is written only when missing or changed (no file-explorer refresh churn every cycle).
- **Bounded browser memory.** Per-workspace state is capped (32 cache entries) and released when a panel unmounts or the host swaps the workspace under the panel.

## Development

```bash
bun install          # deps (bun)
bun run typecheck    # tsc (TypeScript 7 native)
bun test             # unit + integration tests (probe script runs for real)
bun run build        # bundle -> dist/index.js
bun run check        # all of the above + package contract validation
```

Local CI is intentionally local: there is no hosted CI for this package; `bun run check` is the full gate and `bun run publish` runs it before every release.

### Releases (strict semver)

1. Register what the next release will be:

   ```bash
   bun run release:patch    # or release:minor / release:major
   ```

2. When it is time to ship, from a clean `main`:

   ```bash
   bun run publish
   ```

   The script runs the full check suite, bumps the version according to the registered `nextRelease`, resets the marker to `patch`, updates `CHANGELOG.md`, commits `chore(release): vX.Y.Z`, tags `vX.Y.Z`, publishes with `bun publish`, and pushes the tag.

The first release publishes the current version as-is (nothing to bump yet). See [RELEASE-POLICY.md](./RELEASE-POLICY.md) for the full policy.

## Discoverability / listing

There is no plugin marketplace or community listing for PI WEB yet (checked: neither pi-web.dev nor the pi-web repository expose one). Discoverability today:

- npm keywords on this package: `pi-web`, `pi-web-plugin`, `pi-coding-agent`, `github`, `pull-request`, `ci`, `merge`;
- GitHub repository topics on this repo (`pi-web`, `pi-web-plugin`, `github`, `pull-requests`, `ci`);
- the pi-web author accepts feedback/plugin proposals via GitHub issues — worth opening one to request a community listing.

## License

MIT — see [LICENSE](./LICENSE).
