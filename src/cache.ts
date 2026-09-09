import type { TerminalCommandRun, WorkspaceContext } from "@jmfederico/pi-web/plugin-api";
import {
  PROBE_MARKER,
  parseProbeResult,
  readAllProbeFiles,
  readProbeFile,
  type ProbeFiles,
} from "./probe.ts";
import {
  INTERVAL_PATH,
  STOP_PATH,
  TRIGGER_PATH,
  WATCH_COMMAND,
  WATCH_SCRIPT,
  WATCH_SCRIPT_PATH,
  WATCHER_STATE_PATH,
  isWatcherAlive,
  parseWatcherState,
  serializeInterval,
} from "./watch.ts";
import { PLUGIN_ID, SETTINGS_PATH, type PrStatus } from "./types.ts";
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "./settings.ts";
import { effectiveIntervalMs, spawnBackoffMs } from "./schedule.ts";
import { createStatusParser, inlineParser, type StatusParser } from "./workerClient.ts";

interface CacheEntry {
  status?: PrStatus;
  settings?: Settings;
  settingsWarnings: string[];
  settingsError?: string;
  /** Browser-clock milliseconds of the last scratch-file refresh. */
  loadedAt: number;
  /** Browser-clock milliseconds of the last settings read. */
  settingsReadAt: number;
  /** Consecutive watcher spawn failures — drives the spawn backoff. */
  spawnFailures: number;
  /** Browser-clock milliseconds of the last spawn attempt. */
  lastSpawnAttemptAt: number;
  /** Browser-clock milliseconds of the last watcher.json liveness check. */
  lastWatcherCheckAt: number;
  /** Seconds last written into interval.txt (undefined = never written). */
  intervalWrittenSec?: number;
  /** Whether the stop file was written for this entry. */
  stopWritten: boolean;
  /** Browser-clock milliseconds of the last trigger-file write. */
  cycleRequestedAt: number;
  spawnInFlight?: Promise<void>;
  reading?: Promise<void>;
  host?: WorkspaceContext["host"];
  serialized?: string;
}

/** Structural subset of WorkspacePanelTerminal used by the cache. */
export interface TerminalLike {
  runCommand(input: { title: string; command: string; open?: boolean; metadata?: Record<string, string> }): Promise<{
    run: TerminalCommandRun;
    completed: Promise<TerminalCommandRun>;
  }>;
}

const FILE_TTL_MS = 10_000;
/** Settings rarely change; re-read them at most this often. */
const SETTINGS_TTL_MS = 30_000;
/** How often the watcher liveness check may run. */
const LIVENESS_CHECK_TTL_MS = 30_000;
/** Minimum gap between two trigger-file writes. */
const CYCLE_REQUEST_TTL_MS = 5_000;
/** Default wait for a manual watcher cycle. */
export const CYCLE_WAIT_TIMEOUT_MS = 25_000;
/** Marker poll cadence while waiting for a manual cycle. */
const CYCLE_POLL_MS = 400;
const MERGE_CLOSE_TIMEOUT_MS = 60_000;
const MAX_ENTRIES = 32;

/**
 * Shared read-only entry returned for every non-selected workspace. Label
 * and panel callbacks run for every workspace on every host render, so a
 * frozen singleton avoids allocating a throwaway object each time.
 */
const COLD_ENTRY: CacheEntry = Object.freeze({
  settingsWarnings: [],
  loadedAt: 0,
  settingsReadAt: 0,
  spawnFailures: 0,
  lastSpawnAttemptAt: 0,
  lastWatcherCheckAt: 0,
  stopWritten: false,
  cycleRequestedAt: 0,
});

function contextKey(context: WorkspaceContext): string {
  return `${context.machine.id}:${context.workspace.projectId}:${context.workspace.id}`;
}

function nowMs(): number {
  return Date.now();
}

export async function runWorkspaceCommand(
  context: WorkspaceContext & { terminal?: TerminalLike },
  input: { title: string; command: string; op: string; timeoutMs?: number },
): Promise<TerminalCommandRun> {
  if (context.terminal === undefined) throw new Error("Workspace terminal helper is unavailable in this context");
  const handle = await context.terminal.runCommand({
    title: input.title,
    command: input.command,
    open: false,
    metadata: { "pi.plugin": PLUGIN_ID, op: input.op },
  });
  return await withTimeout(handle.completed, input.timeoutMs ?? MERGE_CLOSE_TIMEOUT_MS);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Command timed out after ${String(Math.round(timeoutMs / 1000))}s`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Browser-side cache of probe results and settings, keyed per machine,
 * project and workspace. The singleton is shared by labels, the panel and
 * palette actions; file reads are deduplicated per workspace and parsing runs
 * in a worker (inline fallback) so the main thread never blocks on large CI
 * rollups.
 */
export class StatusCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly parse: StatusParser;

  constructor(parse: StatusParser = createStatusParser()) {
    this.parse = parse;
  }

  get(context: WorkspaceContext): CacheEntry | undefined {
    return this.entries.get(contextKey(context));
  }

  entryStatus(context: WorkspaceContext): PrStatus | undefined {
    return this.entries.get(contextKey(context))?.status;
  }

  /** Key-based variant for palette actions, which have no workspace context. */
  statusByKey(machineId: string, projectId: string, workspaceId: string): PrStatus | undefined {
    return this.entries.get(`${machineId}:${projectId}:${workspaceId}`)?.status;
  }

  entrySettings(context: WorkspaceContext): { settings: Settings; warnings: string[]; error?: string } {
    const entry = this.entries.get(contextKey(context));
    return {
      settings: entry?.settings ?? DEFAULT_SETTINGS,
      warnings: entry?.settingsWarnings ?? [],
      error: entry?.settingsError,
    };
  }

  /** Settings only, with no wrapper allocation — the hot label/panel path. */
  settingsOf(context: WorkspaceContext): Settings {
    return this.entries.get(contextKey(context))?.settings ?? DEFAULT_SETTINGS;
  }

  /**
   * Synchronous cache access for label/panel callbacks: returns the current
   * entry and kicks off a scratch-file refresh when data is missing or stale.
   * Never awaited by callers — updates arrive via host.requestRender().
   */
  ensureLoaded(context: WorkspaceContext): CacheEntry {
    const key = contextKey(context);
    let entry = this.entries.get(key);
    if (entry === undefined) {
      // Only the selected workspace self-populates; other list entries stay
      // cold so labels never trigger bursts of reads for unseen workspaces.
      if (context.state?.selectedWorkspace?.id !== context.workspace.id) return COLD_ENTRY;
      entry = this.evictAndCreate(key);
    }
    entry.host = context.host;
    if (nowMs() - entry.loadedAt > FILE_TTL_MS && entry.reading === undefined) {
      void this.startRead(context, entry, false);
    }
    return entry;
  }

  /** Re-read the probe scratch files (and cached settings) without commands. */
  async refreshFiles(context: WorkspaceContext, options: { forceSettings?: boolean } = {}): Promise<void> {
    const key = contextKey(context);
    const entry = this.entries.get(key) ?? this.evictAndCreate(key);
    entry.host = context.host;
    await this.startRead(context, entry, options.forceSettings === true);
  }

  /**
   * Make sure exactly one long-lived watcher terminal exists for the
   * workspace: pi-web keeps every command-run terminal forever
   * (jmfederico/pi-web#225), so the watcher is spawned once and then only
   * monitored through its watcher.json heartbeat. Fire-and-forget: callers
   * may `void` it; updates arrive via host.requestRender().
   */
  async ensureWatcher(context: WorkspaceContext & { terminal?: TerminalLike }, settings: Settings): Promise<void> {
    const entry = this.entries.get(contextKey(context)) ?? this.evictAndCreate(contextKey(context));
    entry.host = context.host;
    const now = nowMs();

    if (settings.refreshSeconds <= 0) {
      if (!entry.stopWritten) {
        entry.stopWritten = true;
        void context.files.writeFile(STOP_PATH, "1\n", { overwrite: true }).catch(() => undefined);
      }
      return;
    }
    if (entry.stopWritten) {
      entry.stopWritten = false;
      void context.files.deleteFile(STOP_PATH).catch(() => undefined);
    }

    const intervalSec = Math.max(1, Math.round(effectiveIntervalMs(settings, entry.status) / 1000));
    if (entry.intervalWrittenSec !== intervalSec) {
      void context.files
        .writeFile(INTERVAL_PATH, serializeInterval(intervalSec), { overwrite: true })
        .then(() => {
          entry.intervalWrittenSec = intervalSec;
        })
        .catch(() => undefined);
    }

    if (entry.spawnInFlight !== undefined) return await entry.spawnInFlight;
    if (entry.lastWatcherCheckAt !== 0 && now - entry.lastWatcherCheckAt < LIVENESS_CHECK_TTL_MS) return;
    entry.lastWatcherCheckAt = now;

    const state = parseWatcherState(await readProbeFile((path) => context.files.readFile(path), WATCHER_STATE_PATH));
    if (isWatcherAlive(state, state.interval ?? intervalSec, Math.floor(now / 1000))) return;

    const backoff = spawnBackoffMs(entry.spawnFailures);
    if (entry.lastSpawnAttemptAt !== 0 && now - entry.lastSpawnAttemptAt < backoff) return;

    entry.lastSpawnAttemptAt = now;
    entry.spawnInFlight = (async () => {
      try {
        if (context.terminal === undefined) throw new Error("Workspace terminal helper is unavailable in this context");
        await this.ensureWatchScript(context);
        const handle = await context.terminal.runCommand({
          title: "GitHub PR status",
          command: WATCH_COMMAND,
          open: false,
          metadata: { "pi.plugin": PLUGIN_ID, op: "watch" },
        });
        // The watcher runs for hours: its completed promise must never be
        // awaited or left without a handler.
        handle.completed.catch(() => undefined);
        entry.spawnFailures = 0;
      } catch {
        entry.spawnFailures += 1;
      } finally {
        entry.spawnInFlight = undefined;
      }
    })();
    await entry.spawnInFlight;
  }

  /** Write the watcher script only when it is missing or different. */
  private async ensureWatchScript(context: WorkspaceContext): Promise<void> {
    const existing = await readProbeFile((path) => context.files.readFile(path), WATCH_SCRIPT_PATH);
    if (existing === WATCH_SCRIPT) return;
    await context.files.writeFile(WATCH_SCRIPT_PATH, WATCH_SCRIPT, { overwrite: true });
  }

  /**
   * Ask the watcher for an immediate cycle by touching the trigger file.
   * Costs one file write — never a terminal. Throttled so label/panel
   * callbacks can call it liberally.
   */
  requestCycle(context: WorkspaceContext): void {
    const entry = this.entries.get(contextKey(context));
    if (entry === undefined) return;
    const now = nowMs();
    if (now - entry.cycleRequestedAt < CYCLE_REQUEST_TTL_MS) return;
    entry.cycleRequestedAt = now;
    void context.files.writeFile(TRIGGER_PATH, "1\n", { overwrite: true }).catch(() => undefined);
  }

  /**
   * Request a watcher cycle and wait until the probe marker changes, then
   * refresh the cache. Used by the manual Refresh button. Resolves false on
   * timeout without throwing.
   */
  async requestCycleAndWait(context: WorkspaceContext, timeoutMs: number = CYCLE_WAIT_TIMEOUT_MS): Promise<boolean> {
    const entry = this.entries.get(contextKey(context)) ?? this.evictAndCreate(contextKey(context));
    entry.host = context.host;
    let baseline: string | undefined;
    try {
      const file = await context.files.readFile(PROBE_MARKER);
      // The marker timestamp has second granularity, so two cycles may write
      // identical content: also compare the file's modification time.
      baseline = `${file.content}\u0000${file.modifiedAt}`;
    } catch {
      baseline = undefined;
    }
    this.requestCycle(context);
    const deadline = nowMs() + timeoutMs;
    while (nowMs() < deadline) {
      await sleep(CYCLE_POLL_MS);
      let current: string | undefined;
      try {
        const file = await context.files.readFile(PROBE_MARKER);
        current = `${file.content}\u0000${file.modifiedAt}`;
      } catch {
        current = undefined;
      }
      if (current !== undefined && current !== baseline) {
        await this.refreshFiles(context);
        return true;
      }
    }
    return false;
  }

  private startRead(context: WorkspaceContext, entry: CacheEntry, forceSettings: boolean): Promise<void> {
    if (entry.reading !== undefined) return entry.reading;
    entry.reading = (async () => {
      try {
        const settingsStale =
          entry.settings === undefined || forceSettings || nowMs() - entry.settingsReadAt > SETTINGS_TTL_MS;
        const [files, settingsResult] = await Promise.all([
          readAllProbeFiles((path) => context.files.readFile(path)),
          settingsStale ? readSettings(context) : Promise.resolve(cachedSettings(entry)),
        ]);
        const { status, serialized } = await this.parse(files);
        this.apply(entry, status, serialized, settingsResult.settings, settingsResult.warnings, settingsResult.error);
      } catch (error) {
        entry.settingsError = error instanceof Error ? error.message : String(error);
      } finally {
        entry.loadedAt = nowMs();
        entry.reading = undefined;
      }
    })();
    return entry.reading;
  }

  private apply(
    entry: CacheEntry,
    status: PrStatus,
    statusSerialized: string,
    settings: Settings,
    warnings: string[],
    settingsError?: string,
  ): void {
    entry.status = status;
    entry.settings = settings;
    entry.settingsWarnings = warnings;
    entry.settingsError = settingsError;
    entry.settingsReadAt = nowMs();
    const serialized = `${statusSerialized}\u0000${JSON.stringify([settings, warnings, settingsError])}`;
    const changed = entry.serialized !== serialized;
    entry.serialized = serialized;
    if (changed) entry.host?.requestRender();
  }

  private evictAndCreate(key: string): CacheEntry {
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = [...this.entries.entries()].sort((left, right) => left[1].loadedAt - right[1].loadedAt)[0];
      if (oldest !== undefined) this.entries.delete(oldest[0]);
    }
    const entry: CacheEntry = {
      settingsWarnings: [],
      loadedAt: 0,
      settingsReadAt: 0,
      spawnFailures: 0,
      lastSpawnAttemptAt: 0,
      lastWatcherCheckAt: 0,
      stopWritten: false,
      cycleRequestedAt: 0,
    };
    this.entries.set(key, entry);
    return entry;
  }
}

function cachedSettings(entry: CacheEntry): { settings: Settings; warnings: string[]; error?: string } {
  return { settings: entry.settings ?? DEFAULT_SETTINGS, warnings: entry.settingsWarnings, error: entry.settingsError };
}

async function readSettings(context: WorkspaceContext): Promise<{ settings: Settings; warnings: string[]; error?: string }> {
  try {
    const file = await context.files.readFile(SETTINGS_PATH);
    if (file.binary) return { settings: DEFAULT_SETTINGS, warnings: [], error: `${SETTINGS_PATH} is binary` };
    const parsed: unknown = JSON.parse(file.content);
    const { settings, warnings } = normalizeSettings(parsed);
    return { settings, warnings };
  } catch {
    // Missing config file is the normal first-run state.
    return { settings: DEFAULT_SETTINGS, warnings: [] };
  }
}

/** Module-level singleton shared by labels, the panel and actions. */
export const statusCache = new StatusCache();
