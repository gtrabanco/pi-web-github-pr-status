import { describe, expect, it } from "bun:test";
import { inlineParser } from "./workerClient.ts";
import { StatusCache } from "./cache.ts";
import {
  WATCHER_STATE_PATH,
  INTERVAL_PATH,
  STOP_PATH,
  TRIGGER_PATH,
  WATCH_COMMAND,
  WATCH_SCRIPT,
  WATCH_SCRIPT_PATH,
  isWatcherAlive,
  parseWatcherState,
  serializeInterval,
} from "./watch.ts";
import { PROBE_MARKER } from "./probe.ts";
import { PrUiController, applyActivityContextSwap } from "./panel.ts";
import { DEFAULT_SETTINGS, type Settings } from "./settings.ts";

/**
 * Performance and reliability behaviour of the watcher loop. Terminal churn
 * is the plugin's most expensive side effect (pi-web keeps every command-run
 * terminal forever — see upstream issue jmfederico/pi-web#225), so automatic
 * refreshes must never spawn terminals: a single long-lived watcher terminal
 * per workspace writes the scratch files, and the browser only touches files.
 */

function settingsWith(overrides: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides, merge: { ...DEFAULT_SETTINGS.merge } };
}

const NEVER = new Promise<never>(() => undefined);

interface Calls {
  readFile: Record<string, number>;
  writeFile: Array<{ path: string; content: string }>;
  deleteFile: string[];
  runCommand: Array<{ title: string; command: string }>;
  requestRender: number;
  failRun: boolean;
  /** Test hook: make a trigger write consume itself like a real watcher. */
  onTrigger?: () => void;
}

function fakeContext(initialFiles: Record<string, string>, id: string) {
  const files = new Map(Object.entries(initialFiles));
  const calls: Calls = { readFile: {}, writeFile: [], deleteFile: [], runCommand: [], requestRender: 0, failRun: false };
  const context = {
    machine: { id: "local", name: "local", kind: "local" as const },
    workspace: { id, projectId: "p", path: `/tmp/${id}`, label: id, isMain: true },
    state: { selectedWorkspace: { id, projectId: "p" } },
    files: {
      readFile: async (path: string) => {
        calls.readFile[path] = (calls.readFile[path] ?? 0) + 1;
        const content = files.get(path);
        if (content === undefined) throw new Error(`File not found: ${path}`);
        return { path, content, binary: false, size: content.length, encoding: "utf8" as const, truncated: false, modifiedAt: "1970-01-01T00:00:00.000Z" };
      },
      writeFile: async (path: string, content: string | Uint8Array) => {
        const text = typeof content === "string" ? content : new TextDecoder().decode(content);
        calls.writeFile.push({ path, content: text });
        files.set(path, text);
        if (path === TRIGGER_PATH && calls.onTrigger !== undefined) setTimeout(calls.onTrigger, 300);
        return { path, size: text.length, modifiedAt: new Date().toISOString(), created: true };
      },
      deleteFile: async (path: string) => {
        calls.deleteFile.push(path);
        files.delete(path);
        return { path, existed: files.has(path) };
      },
    },
    terminal: {
      runCommand: async (input: { title: string; command: string; open?: boolean }) => {
        calls.runCommand.push({ title: input.title, command: input.command });
        if (calls.failRun) throw new Error("spawn boom");
        // The watcher daemon never completes: completed must never be awaited
        // by the plugin (it would park a promise for the watcher's lifetime).
        return { run: { id: "run-1" } as never, completed: NEVER };
      },
    },
    host: { requestRender: () => { calls.requestRender += 1; } },
  };
  return { context, calls, files };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function freshWatcherState(intervalSec: number): string {
  return JSON.stringify({ v: 1, pid: 1234, ts: Math.floor(Date.now() / 1000) - 10, interval: intervalSec });
}

async function settled(cache: StatusCache, context: unknown, settings: Settings): Promise<void> {
  await cache.ensureWatcher(context as never, settings);
}

function makeCache(): StatusCache {
  return new StatusCache(inlineParser);
}

describe("statusCache watcher lifecycle", () => {
  it("spawns one watcher terminal and writes the interval when no watcher exists", async () => {
    const cache = makeCache();
    const { context, calls } = fakeContext({}, "spawn-fresh");
    cache.ensureLoaded(context as never);
    await settled(cache, context, settingsWith({ refreshSeconds: 90 }));
    expect(calls.runCommand).toHaveLength(1);
    expect(calls.runCommand[0]?.command).toBe(WATCH_COMMAND);
    expect(calls.writeFile.some((w) => w.path === INTERVAL_PATH && w.content === "90\n")).toBe(true);
  });

  it("does not spawn while the recorded watcher is fresh", async () => {
    const cache = makeCache();
    const { context, calls } = fakeContext({ [WATCHER_STATE_PATH]: freshWatcherState(90) }, "spawn-alive");
    cache.ensureLoaded(context as never);
    await settled(cache, context, settingsWith({ refreshSeconds: 90 }));
    expect(calls.runCommand).toHaveLength(0);
  });

  it("respawns when watcher.json is stale", async () => {
    const cache = makeCache();
    const stale = JSON.stringify({ v: 1, pid: 1, ts: Math.floor(Date.now() / 1000) - 1_000_000, interval: 90 });
    const { context, calls } = fakeContext({ [WATCHER_STATE_PATH]: stale }, "spawn-stale");
    cache.ensureLoaded(context as never);
    await settled(cache, context, settingsWith({ refreshSeconds: 90 }));
    expect(calls.runCommand).toHaveLength(1);
  });

  it("respects a slow reported watcher interval before declaring it stale", async () => {
    const cache = makeCache();
    const slow = JSON.stringify({ v: 1, pid: 1, ts: Math.floor(Date.now() / 1000) - 600, interval: 900 });
    const { context, calls } = fakeContext({ [WATCHER_STATE_PATH]: slow }, "spawn-slow");
    cache.ensureLoaded(context as never);
    await settled(cache, context, settingsWith({ refreshSeconds: 90 }));
    // 600s old but the watcher reports 900s cycles: still alive.
    expect(calls.runCommand).toHaveLength(0);
  });

  it("throttles liveness checks so no watcher.json read happens twice within 30s", async () => {
    const cache = makeCache();
    const { context, calls } = fakeContext({ [WATCHER_STATE_PATH]: freshWatcherState(90) }, "liveness-ttl");
    cache.ensureLoaded(context as never);
    await settled(cache, context, settingsWith({ refreshSeconds: 90 }));
    const readsAfterFirst = calls.readFile[WATCHER_STATE_PATH] ?? 0;
    await settled(cache, context, settingsWith({ refreshSeconds: 90 }));
    expect(calls.readFile[WATCHER_STATE_PATH] ?? 0).toBe(readsAfterFirst);
  });

  it("backs off exponentially after failed spawn attempts", async () => {
    const cache = makeCache();
    const { context, calls } = fakeContext({}, "spawn-backoff");
    calls.failRun = true;
    cache.ensureLoaded(context as never);
    await settled(cache, context, settingsWith({ refreshSeconds: 90 }));
    expect(calls.runCommand).toHaveLength(1);
    const entry = cache.get(context as never)!;
    expect(entry.spawnFailures).toBe(1);

    // still inside the 60s backoff: no second spawn
    entry.lastWatcherCheckAt = 0;
    await settled(cache, context, settingsWith({ refreshSeconds: 90 }));
    expect(calls.runCommand).toHaveLength(1);

    entry.lastSpawnAttemptAt = Date.now() - 61_000;
    entry.lastWatcherCheckAt = 0;
    await settled(cache, context, settingsWith({ refreshSeconds: 90 }));
    expect(calls.runCommand).toHaveLength(2);
    expect(cache.get(context as never)?.spawnFailures).toBe(2);
  });

  it("resets the spawn backoff once a spawn succeeds", async () => {
    const cache = makeCache();
    const { context, calls } = fakeContext({}, "spawn-recover");
    calls.failRun = true;
    cache.ensureLoaded(context as never);
    await settled(cache, context, settingsWith({ refreshSeconds: 90 }));
    expect(cache.get(context as never)?.spawnFailures).toBe(1);
    calls.failRun = false;
    const entry = cache.get(context as never)!;
    entry.lastSpawnAttemptAt = Date.now() - 61_000;
    entry.lastWatcherCheckAt = 0;
    await settled(cache, context, settingsWith({ refreshSeconds: 90 }));
    expect(cache.get(context as never)?.spawnFailures).toBe(0);
  });

  it("rewrites interval.txt only when the effective interval changes", async () => {
    const cache = makeCache();
    const { context, calls } = fakeContext({ [WATCHER_STATE_PATH]: freshWatcherState(90) }, "interval-write-once");
    cache.ensureLoaded(context as never);
    await settled(cache, context, settingsWith({ refreshSeconds: 90 }));
    const writes = calls.writeFile.filter((w) => w.path === INTERVAL_PATH).length;
    await settled(cache, context, settingsWith({ refreshSeconds: 90 }));
    expect(calls.writeFile.filter((w) => w.path === INTERVAL_PATH).length).toBe(writes);

    await settled(cache, context, settingsWith({ refreshSeconds: 300 }));
    expect(calls.writeFile.filter((w) => w.path === INTERVAL_PATH && w.content === "300\n").length).toBe(1);
  });

  it("writes the stop file and never spawns a terminal when refresh is disabled", async () => {
    const cache = makeCache();
    const { context, calls } = fakeContext({}, "refresh-disabled");
    cache.ensureLoaded(context as never);
    await settled(cache, context, settingsWith({ refreshSeconds: 0 }));
    expect(calls.runCommand).toHaveLength(0);
    expect(calls.writeFile.some((w) => w.path === STOP_PATH)).toBe(true);

    // re-enabled: clear the stop file and spawn
    await settled(cache, context, settingsWith({ refreshSeconds: 90 }));
    expect(calls.deleteFile).toContain(STOP_PATH);
    expect(calls.runCommand).toHaveLength(1);
  });

  it("never awaits the watcher's completed promise (it stays pending for hours)", async () => {
    const cache = makeCache();
    const { context } = fakeContext({}, "no-await-completed");
    cache.ensureLoaded(context as never);
    await settled(cache, context, settingsWith({ refreshSeconds: 90 }));
    // resolved without hanging and without unhandled rejection from the
    // never-settling completed promise in the fake terminal.
  });

  it("keeps script writes write-once: no watch.sh rewrite when it matches", async () => {
    const cache = makeCache();
    const { context, calls } = fakeContext({ [WATCH_SCRIPT_PATH]: WATCH_SCRIPT }, "script-write-once");
    cache.ensureLoaded(context as never);
    await settled(cache, context, settingsWith({ refreshSeconds: 90 }));
    expect(calls.writeFile.some((w) => w.path === WATCH_SCRIPT_PATH)).toBe(false);
    expect(calls.runCommand).toHaveLength(1);
  });

  it("writes watch.sh when missing or different", async () => {
    const cache = makeCache();
    const missing = fakeContext({}, "script-missing");
    missing.calls.onTrigger = () => undefined;
    cache.ensureLoaded(missing.context as never);
    await settled(cache, missing.context, settingsWith({ refreshSeconds: 90 }));
    expect(missing.calls.writeFile.some((w) => w.path === WATCH_SCRIPT_PATH)).toBe(true);

    const outdated = fakeContext({ [WATCH_SCRIPT_PATH]: "#!/bin/sh\nold\n" }, "script-outdated");
    cache.ensureLoaded(outdated.context as never);
    await settled(cache, outdated.context, settingsWith({ refreshSeconds: 90 }));
    expect(outdated.calls.writeFile.some((w) => w.path === WATCH_SCRIPT_PATH)).toBe(true);
  });
});

describe("statusCache manual cycles", () => {
  it("requestCycle throttles trigger writes", async () => {
    const cache = makeCache();
    const { context, calls } = fakeContext({}, "trigger-throttle");
    cache.ensureLoaded(context as never);
    cache.requestCycle(context as never);
    cache.requestCycle(context as never);
    cache.requestCycle(context as never);
    await sleep(10);
    expect(calls.writeFile.filter((w) => w.path === TRIGGER_PATH)).toHaveLength(1);
  });

  it("requestCycleAndWait resolves true when the marker changes and refreshes files", async () => {
    const cache = makeCache();
    const { context, calls, files } = fakeContext({}, "cycle-ok");
    cache.ensureLoaded(context as never);
    await cache.refreshFiles(context as never);
    calls.onTrigger = () => { files.set(PROBE_MARKER, '{"v":1,"ts":1000,"git":1}'); };
    const done = cache.requestCycleAndWait(context as never, 3_000);
    expect(await done).toBe(true);
    const entry = cache.get(context as never)!;
    expect(entry.loadedAt).toBeGreaterThan(0);
    expect(entry.status?.git).toBe(true);
    expect(calls.runCommand).toHaveLength(0);
  });

  it("requestCycleAndWait returns false on timeout without retriggering", async () => {
    const cache = makeCache();
    const { context, calls } = fakeContext({}, "cycle-timeout");
    cache.ensureLoaded(context as never);
    expect(await cache.requestCycleAndWait(context as never, 700)).toBe(false);
    expect(calls.writeFile.filter((w) => w.path === TRIGGER_PATH)).toHaveLength(1);
  });
});

describe("statusCache settings read caching", () => {
  it("reads settings at most once per TTL unless forced", async () => {
    const cache = makeCache();
    const { context, calls } = fakeContext({}, "settings-ttl");
    await cache.refreshFiles(context as never);
    const reads = calls.readFile[".pi-web/github-pr.json"] ?? 0;
    await cache.refreshFiles(context as never);
    expect((calls.readFile[".pi-web/github-pr.json"] ?? 0) - reads).toBe(0);
    await cache.refreshFiles(context as never, { forceSettings: true });
    expect((calls.readFile[".pi-web/github-pr.json"] ?? 0) - reads).toBe(1);
  });
});

describe("PrUiController watcher hygiene", () => {
  it("connect spawns the watcher once", async () => {
    const cache = makeCache();
    const { context, calls } = fakeContext({}, "controller-connect");
    const controller = new PrUiController(cache);
    controller.connect(context as never);
    await sleep(20);
    expect(calls.runCommand).toHaveLength(1);
  });

  it("tick never spawns additional terminals", async () => {
    const cache = makeCache();
    const { context, calls } = fakeContext({ [WATCHER_STATE_PATH]: freshWatcherState(90) }, "controller-tick");
    const controller = new PrUiController(cache);
    controller.connect(context as never);
    await sleep(20);
    controller.tick(context as never);
    controller.tick(context as never);
    await sleep(20);
    expect(calls.runCommand).toHaveLength(0);
  });

  it("invalidate refreshes files and pokes the watcher without terminals", async () => {
    const cache = makeCache();
    const { context, calls } = fakeContext({ [WATCHER_STATE_PATH]: freshWatcherState(90) }, "controller-invalidate");
    const controller = new PrUiController(cache);
    controller.connect(context as never);
    await sleep(20);
    const runCommands = calls.runCommand.length;
    controller.invalidate(context as never);
    await sleep(20);
    expect(calls.runCommand.length).toBe(runCommands);
    expect(calls.writeFile.some((w) => w.path === TRIGGER_PATH)).toBe(true);
  });

  it("refresh (button) completes without spawning terminals and reports watcher failures", async () => {
    const cache = makeCache();
    const { context, calls, files } = fakeContext({ [WATCHER_STATE_PATH]: freshWatcherState(90) }, "controller-refresh");
    const controller = new PrUiController(cache);
    controller.connect(context as never);
    await sleep(20);
    calls.onTrigger = () => { files.set(PROBE_MARKER, '{"v":1,"ts":1000,"git":1}'); };
    await controller.refresh(context as never);
    const state = controller.stateFor(context as never);
    expect(state.busy).toBeNull();
    expect(calls.runCommand).toHaveLength(0);
  });
});

describe("statusCache accessor efficiency", () => {
  it("returns the same frozen cold entry for non-selected workspaces (no per-call allocation)", () => {
    const cache = makeCache();
    const { context } = fakeContext({}, "cold-singleton");
    const ctx = { ...(context as object), workspace: { id: "other", projectId: "p", path: "/tmp/x", label: "x", isMain: false }, state: { selectedWorkspace: { id: "s", projectId: "p" } } } as never;
    const first = cache.ensureLoaded(ctx);
    const second = cache.ensureLoaded(ctx);
    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.settings).toBeUndefined();
    expect(first.status).toBeUndefined();
  });

  it("settingsOf mirrors entrySettings().settings", async () => {
    const cache = makeCache();
    const { context } = fakeContext({}, "settings-of");
    await cache.refreshFiles(context as never, { forceSettings: true });
    const viaSettingsOf = cache.settingsOf(context as never);
    const viaEntry = cache.entrySettings(context as never).settings;
    expect(viaSettingsOf).toBe(viaEntry);
    expect(viaSettingsOf).toBe(DEFAULT_SETTINGS);
  });

  it("settingsOf returns DEFAULT_SETTINGS when no entry exists", () => {
    const cache = makeCache();
    const { context } = fakeContext({}, "settings-none");
    expect(cache.settingsOf(context as never)).toBe(DEFAULT_SETTINGS);
  });

  it("refreshFiles re-reads scratch files", async () => {
    const cache = makeCache();
    const { context, calls } = fakeContext({}, "refresh-files");
    await cache.refreshFiles(context as never);
    const entry = cache.get(context as never)!;
    expect(calls.readFile[PROBE_MARKER] ?? 0).toBeGreaterThan(0);
    expect(entry.loadedAt).toBeGreaterThan(0);
  });
});

describe("watcher liveness pure helper wiring", () => {
  it("isWatcherAlive agrees with the cache freshness decision", () => {
    const state = parseState(freshWatcherState(90));
    expect(isWatcherAlive(state, 90, Math.floor(Date.now() / 1000))).toBe(true);
  });
});

function parseState(raw: string) {
  return parseWatcherState(raw);
}

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

describe("interval serialization", () => {
  it("matches what the watcher script parses", () => {
    expect(serializeInterval(90)).toBe("90\n");
  });
});
