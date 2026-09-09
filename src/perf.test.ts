import { describe, expect, it } from "bun:test";
import { statusCache } from "./cache.ts";
import {
  ADAPTIVE_FAILED_FLOOR_MS,
  ADAPTIVE_RUNNING_FLOOR_MS,
  MAX_PROBE_BACKOFF_MS,
  MIN_AUTOMATIC_PROBE_MS,
  PrUiController,
  applyActivityContextSwap,
  automaticProbeThresholdMs,
  effectiveProbeIntervalMs,
} from "./panel.ts";
import { PROBE_SCRIPT, PROBE_SCRIPT_PATH } from "./probe.ts";
import { DEFAULT_SETTINGS, type Settings } from "./settings.ts";
import type { PrStatus } from "./types.ts";

/**
 * Performance and reliability behaviour of the probe loop: terminal churn is
 * the plugin's most expensive side effect (pi-web keeps every command-run
 * terminal forever — see upstream issue jmfederico/pi-web#225), so automatic
 * probes must be bounded, back off after failures, and never burst.
 */

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

interface FakeCalls {
  readFile: number;
  writeFile: number;
  runCommand: number;
  requestRender: number;
  failRun: boolean;
}

function fakeContext(scriptContent: string | undefined, id: string): { context: unknown; calls: FakeCalls } {
  const calls: FakeCalls = { readFile: 0, writeFile: 0, runCommand: 0, requestRender: 0, failRun: false };
  const run = (status: "succeeded" | "failed") => ({
    id: "run-1",
    origin: "github-pr-status",
    projectId: "p",
    workspaceId: id,
    terminalId: "term-1",
    title: "GitHub PR status",
    command: "sh probe.sh",
    status,
    createdAt: new Date().toISOString(),
    metadata: {},
  });
  const context = {
    machine: { id: "local", name: "local", kind: "local" as const },
    workspace: { id, projectId: "p", path: `/tmp/${id}`, label: id, isMain: true },
    state: { selectedWorkspace: { id, projectId: "p" } },
    files: {
      readFile: async (path: string) => {
        calls.readFile += 1;
        if (path === PROBE_SCRIPT_PATH && scriptContent !== undefined) {
          return { content: scriptContent, binary: false };
        }
        throw new Error(`File not found: ${path}`);
      },
      writeFile: async (path: string) => {
        calls.writeFile += 1;
        return { path, size: PROBE_SCRIPT.length, modifiedAt: new Date().toISOString() };
      },
    },
    terminal: {
      runCommand: async (input: { title: string; command: string; open?: boolean }) => {
        calls.runCommand += 1;
        if (calls.failRun) return { run: run("failed"), completed: Promise.reject(new Error("probe boom")) };
        return { run: run("succeeded"), completed: Promise.resolve(run("succeeded")) };
      },
    },
    host: { requestRender: () => { calls.requestRender += 1; } },
  };
  return { context, calls };
}

describe("effectiveProbeIntervalMs", () => {
  it("uses the configured interval by default", () => {
    expect(effectiveProbeIntervalMs(settingsWith({ refreshSeconds: 90 }), undefined, 0)).toBe(90_000);
  });

  it("floors the adaptive running interval at 30s", () => {
    expect(effectiveProbeIntervalMs(settingsWith({ refreshSeconds: 90 }), statusWithCi("running"), 0)).toBe(ADAPTIVE_RUNNING_FLOOR_MS);
    expect(ADAPTIVE_RUNNING_FLOOR_MS).toBe(30_000);
  });

  it("floors the adaptive failed interval at 60s", () => {
    expect(effectiveProbeIntervalMs(settingsWith({ refreshSeconds: 90 }), statusWithCi("failed"), 0)).toBe(ADAPTIVE_FAILED_FLOOR_MS);
    expect(ADAPTIVE_FAILED_FLOOR_MS).toBe(60_000);
  });

  it("never stretches a shorter configured interval", () => {
    expect(effectiveProbeIntervalMs(settingsWith({ refreshSeconds: 10 }), statusWithCi("running"), 0)).toBe(10_000);
  });

  it("ignores the adaptive floor when disabled", () => {
    expect(effectiveProbeIntervalMs(settingsWith({ refreshSeconds: 90, adaptiveRefresh: false }), statusWithCi("running"), 0)).toBe(90_000);
  });

  it("doubles the interval after each consecutive probe failure", () => {
    const settings = settingsWith({ refreshSeconds: 90 });
    expect(effectiveProbeIntervalMs(settings, undefined, 1)).toBe(180_000);
    expect(effectiveProbeIntervalMs(settings, undefined, 2)).toBe(360_000);
    expect(effectiveProbeIntervalMs(settings, statusWithCi("running"), 1)).toBe(60_000);
  });

  it("caps the backoff at 15 minutes", () => {
    expect(effectiveProbeIntervalMs(settingsWith({ refreshSeconds: 90 }), undefined, 5)).toBe(MAX_PROBE_BACKOFF_MS);
    expect(effectiveProbeIntervalMs(settingsWith({ refreshSeconds: 90 }), undefined, 20)).toBe(MAX_PROBE_BACKOFF_MS);
    expect(MAX_PROBE_BACKOFF_MS).toBe(900_000);
  });
});

describe("automaticProbeThresholdMs", () => {
  it("enforces a 30s floor for automatic probes", () => {
    expect(MIN_AUTOMATIC_PROBE_MS).toBe(30_000);
    expect(automaticProbeThresholdMs(settingsWith({ refreshSeconds: 5 }), undefined, 0)).toBe(30_000);
  });

  it("keeps larger configured intervals", () => {
    expect(automaticProbeThresholdMs(settingsWith({ refreshSeconds: 90 }), undefined, 0)).toBe(90_000);
  });
});

describe("statusCache probe hygiene", () => {
  it("skips rewriting probe.sh when the on-disk script already matches", async () => {
    const { context, calls } = fakeContext(PROBE_SCRIPT, "write-once");
    await statusCache.probe(context as never);
    await statusCache.probe(context as never);
    expect(calls.runCommand).toBe(2);
    expect(calls.writeFile).toBe(0);
  });

  it("writes probe.sh when missing or different", async () => {
    const missing = fakeContext(undefined, "write-missing");
    await statusCache.probe(missing.context as never);
    expect(missing.calls.writeFile).toBe(1);

    const outdated = fakeContext("#!/bin/sh\nold\n", "write-outdated");
    await statusCache.probe(outdated.context as never);
    expect(outdated.calls.writeFile).toBe(1);
  });

  it("records when the probe started", async () => {
    const { context } = fakeContext(PROBE_SCRIPT, "started-at");
    const before = Date.now();
    await statusCache.probe(context as never);
    const entry = statusCache.get(context as never);
    expect(entry?.probeStartedAt).toBeGreaterThanOrEqual(before);
  });

  it("counts consecutive probe failures and resets on success", async () => {
    const { context, calls } = fakeContext(PROBE_SCRIPT, "failures");
    calls.failRun = true;
    await expect(statusCache.probe(context as never)).rejects.toThrow("probe boom");
    await expect(statusCache.probe(context as never)).rejects.toThrow("probe boom");
    expect(statusCache.get(context as never)?.probeFailures).toBe(2);

    calls.failRun = false;
    await statusCache.probe(context as never);
    expect(statusCache.get(context as never)?.probeFailures).toBe(0);
  });
});

describe("PrUiController automatic probe bounds", () => {
  it("invalidate reads files instead of probing within the automatic floor", async () => {
    const { context, calls } = fakeContext(PROBE_SCRIPT, "invalidate-floor");
    statusCache.ensureLoaded(context as never);
    const entry = statusCache.get(context as never);
    expect(entry).toBeDefined();
    entry!.probeStartedAt = Date.now() - 5_000;
    const readsBefore = calls.readFile;

    new PrUiController().invalidate(context as never);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.runCommand).toBe(0);
    expect(calls.readFile).toBeGreaterThan(readsBefore);
  });

  it("invalidate probes again once the automatic floor elapsed", async () => {
    const { context, calls } = fakeContext(PROBE_SCRIPT, "invalidate-elapse");
    statusCache.ensureLoaded(context as never);
    const entry = statusCache.get(context as never);
    entry!.probeStartedAt = Date.now() - MIN_AUTOMATIC_PROBE_MS - 1_000;

    new PrUiController().invalidate(context as never);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.runCommand).toBe(1);
  });

  it("tick does not probe while the interval has not elapsed", async () => {
    const { context, calls } = fakeContext(PROBE_SCRIPT, "tick-wait");
    statusCache.ensureLoaded(context as never);
    const entry = statusCache.get(context as never);
    entry!.probeStartedAt = entry!.probedAt = entry!.loadedAt = Date.now() - 10_000;

    new PrUiController().tick(context as never);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.runCommand).toBe(0);
  });

  it("tick backs off after consecutive probe failures", async () => {
    const { context, calls } = fakeContext(PROBE_SCRIPT, "tick-backoff");
    statusCache.ensureLoaded(context as never);
    const entry = statusCache.get(context as never);
    entry!.probeFailures = 2;
    entry!.probeStartedAt = entry!.probedAt = entry!.loadedAt = Date.now() - 60_000;

    new PrUiController().tick(context as never);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.runCommand).toBe(0);

    entry!.probeFailures = 0;
    entry!.probeStartedAt = entry!.probedAt = entry!.loadedAt = Date.now() - 91_000;
    new PrUiController().tick(context as never);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.runCommand).toBe(1);
  });
});

describe("applyActivityContextSwap", () => {
  const record = { connected: [] as string[], disconnected: [] as string[] };
  const controller = {
    connect: (context: { workspace: { id: string } }) => { record.connected.push(context.workspace.id); },
    disconnect: (context: { workspace: { id: string } }) => { record.disconnected.push(context.workspace.id); },
  };
  const ctxA = { workspace: { id: "a" } } as never;
  const ctxB = { workspace: { id: "b" } } as never;

  it("swaps connect/disconnect when the element is connected", () => {
    record.connected.length = 0;
    record.disconnected.length = 0;
    applyActivityContextSwap(controller, ctxA, ctxB, true);
    expect(record.disconnected).toEqual(["a"]);
    expect(record.connected).toEqual(["b"]);
  });

  it("does nothing while the element is not connected", () => {
    record.connected.length = 0;
    record.disconnected.length = 0;
    applyActivityContextSwap(controller, ctxA, ctxB, false);
    expect(record.disconnected).toEqual([]);
    expect(record.connected).toEqual([]);
  });

  it("ignores identical contexts", () => {
    record.connected.length = 0;
    record.disconnected.length = 0;
    applyActivityContextSwap(controller, ctxA, ctxA, true);
    expect(record.disconnected).toEqual([]);
    expect(record.connected).toEqual([]);
  });
});
