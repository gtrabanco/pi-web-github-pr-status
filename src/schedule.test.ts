import { describe, expect, it } from "bun:test";
import {
  ADAPTIVE_FAILED_FLOOR_MS,
  ADAPTIVE_RUNNING_FLOOR_MS,
  MAX_SPAWN_BACKOFF_MS,
  WATCHER_STALE_FLOOR_MS,
  WATCHER_STALE_SLACK_MS,
  effectiveIntervalMs,
  spawnBackoffMs,
  watcherFreshWindowMs,
} from "./schedule.ts";
import { DEFAULT_SETTINGS, type Settings } from "./settings.ts";
import type { PrStatus } from "./types.ts";

function settingsWith(overrides: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides, merge: { ...DEFAULT_SETTINGS.merge } };
}

function statusWithCi(state: PrStatus["ci"]["state"]): PrStatus {
  return {
    git: true,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
    hasUpstream: true,
    ci: { state, total: 3, passed: 0, running: 0, failed: 0, checks: [] },
  };
}

describe("effectiveIntervalMs", () => {
  it("uses the configured interval by default", () => {
    expect(effectiveIntervalMs(settingsWith({ refreshSeconds: 90 }), undefined)).toBe(90_000);
  });

  it("floors the adaptive running interval at 30s", () => {
    expect(effectiveIntervalMs(settingsWith({ refreshSeconds: 90 }), statusWithCi("running"))).toBe(ADAPTIVE_RUNNING_FLOOR_MS);
    expect(ADAPTIVE_RUNNING_FLOOR_MS).toBe(30_000);
  });

  it("floors the adaptive failed interval at 60s", () => {
    expect(effectiveIntervalMs(settingsWith({ refreshSeconds: 90 }), statusWithCi("failed"))).toBe(ADAPTIVE_FAILED_FLOOR_MS);
    expect(ADAPTIVE_FAILED_FLOOR_MS).toBe(60_000);
  });

  it("never stretches a shorter configured interval", () => {
    expect(effectiveIntervalMs(settingsWith({ refreshSeconds: 10 }), statusWithCi("running"))).toBe(10_000);
  });

  it("ignores the adaptive floor when disabled", () => {
    expect(effectiveIntervalMs(settingsWith({ refreshSeconds: 90, adaptiveRefresh: false }), statusWithCi("running"))).toBe(90_000);
  });
});

describe("spawnBackoffMs", () => {
  it("does not back off the first spawn attempt", () => {
    expect(spawnBackoffMs(0)).toBe(0);
  });

  it("doubles the wait after each consecutive spawn failure", () => {
    expect(spawnBackoffMs(1)).toBe(60_000);
    expect(spawnBackoffMs(2)).toBe(120_000);
  });

  it("caps the backoff at 15 minutes", () => {
    expect(spawnBackoffMs(5)).toBe(MAX_SPAWN_BACKOFF_MS);
    expect(spawnBackoffMs(20)).toBe(MAX_SPAWN_BACKOFF_MS);
    expect(MAX_SPAWN_BACKOFF_MS).toBe(900_000);
  });
});

describe("watcherFreshWindowMs", () => {
  it("never considers a watcher stale in under 2 minutes", () => {
    expect(WATCHER_STALE_FLOOR_MS).toBe(120_000);
    expect(watcherFreshWindowMs(0)).toBe(WATCHER_STALE_FLOOR_MS + WATCHER_STALE_SLACK_MS);
  });

  it("scales with the watcher cycle interval plus slack", () => {
    expect(watcherFreshWindowMs(90_000)).toBe(180_000 + WATCHER_STALE_SLACK_MS);
    expect(watcherFreshWindowMs(900_000)).toBe(1_800_000 + WATCHER_STALE_SLACK_MS);
    expect(WATCHER_STALE_SLACK_MS).toBe(30_000);
  });
});
