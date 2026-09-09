/** Refresh cadence and watcher-liveness math shared by the cache and the panel. */

import type { Settings } from "./settings.ts";
import type { PrStatus } from "./types.ts";

/** Lower bound for the adaptive interval while CI is running. */
export const ADAPTIVE_RUNNING_FLOOR_MS = 30_000;
/** Lower bound for the adaptive interval while CI is failing. */
export const ADAPTIVE_FAILED_FLOOR_MS = 60_000;
/** Upper bound for the consecutive-failure spawn backoff. */
export const MAX_SPAWN_BACKOFF_MS = 15 * 60_000;
/** A watcher is never declared stale faster than this. */
export const WATCHER_STALE_FLOOR_MS = 120_000;
/** Extra slack added on top of two watcher cycles before declaring staleness. */
export const WATCHER_STALE_SLACK_MS = 30_000;
const MAX_SPAWN_BACKOFF_EXPONENT = 5;

/**
 * Interval between watcher fact-collection cycles for a workspace: the
 * configured interval, optionally lowered by the adaptive CI floors. Unlike
 * the old per-probe cadence this does not grow with failures — the watcher is
 * a single self-healing terminal, and spawn attempts (the only fallible step)
 * back off separately through `spawnBackoffMs`.
 */
export function effectiveIntervalMs(settings: Settings, status: PrStatus | undefined): number {
  let ms = settings.refreshSeconds * 1000;
  if (settings.adaptiveRefresh && status !== undefined) {
    const state = status.ci.state;
    if (state === "running") ms = Math.min(ms, ADAPTIVE_RUNNING_FLOOR_MS);
    else if (state === "failed") ms = Math.min(ms, ADAPTIVE_FAILED_FLOOR_MS);
  }
  return ms;
}

/**
 * Wait required before retrying a failed watcher spawn: 0 for the first
 * attempt, then 60s (2×30s) doubling per consecutive failure, capped at 15 minutes so
 * a broken machine cannot fork-bomb itself with stuck ptys.
 */
export function spawnBackoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(MAX_SPAWN_BACKOFF_MS, 30_000 * 2 ** Math.min(failures, MAX_SPAWN_BACKOFF_EXPONENT));
}

/**
 * How long a watcher may go without touching watcher.json before it is
 * considered dead: two of its own cycles (never less than two minutes) plus
 * slack for a slow `gh` call inside the current cycle.
 */
export function watcherFreshWindowMs(watcherIntervalMs: number): number {
  return Math.max(WATCHER_STALE_FLOOR_MS, 2 * watcherIntervalMs) + WATCHER_STALE_SLACK_MS;
}
