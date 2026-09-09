# Changelog

All notable changes to this project are documented here. The project follows [strict semantic versioning](./RELEASE-POLICY.md); the kind of the next release is registered in `package.json` (`nextRelease`) before `bun run publish` is executed.

- Fixed page freezes caused by terminal churn: automatic probes spawned one workspace terminal each, and pi-web keeps every terminal forever ([jmfederico/pi-web#225]). The plugin now runs **one long-lived watcher terminal per workspace** that writes status files on a loop; every other refresh path (manual, invalidation, post-merge) only touches files.
- Watcher self-termination (`stop` file, interval 0, 12 h lifetime cap), stale-heartbeat detection and respawn with exponential backoff (capped at 15 min).
- Status parsing and serialization moved to a Web Worker (inline fallback) so large CI rollups never block the page's main thread.
- Settings file re-read at most every 30 s; `gh` calls inside the watcher are bounded by `timeout 20`.
- Fixed Pull Request panel freeze: the host passes a **brand-new context object** on every render, and the activity element was treating object identity as a disconnect/reconnect. That made `connect()` → `requestRender()` → fresh context → swap → `connect()` loop forever, freezing pi-web whenever the tab was opened (closing it stopped the loop). The context swap now keys on the **workspace identity** (machine + project + workspace) instead of the object reference, so same-workspace re-renders no longer re-trigger a render.

## 0.1.2 — 2026-09-09 (Patch release)

- See commit history for details.

## 0.1.1 — 2026-09-08 (Patch release)

- See commit history for details.

## 0.1.0 — initial development version

- GitHub PR workspace label: PR number link, CI ball (green/orange/red/none), dirty-worktree marker, push/pull arrows.
- Pull Request panel: PR card, CI check list, worktree summary, guarded one-click merge and confirmed close.
- Per-workspace settings in `.pi-web/github-pr.json` with an in-panel editor.
- Local-first release tooling (`bun run publish`), TypeScript 7, bun as package manager.
