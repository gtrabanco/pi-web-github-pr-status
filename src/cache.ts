import type { TerminalCommandRun, WorkspaceContext } from "@jmfederico/pi-web/plugin-api";
import {
  PROBE_COMMAND,
  PROBE_SCRIPT,
  PROBE_SCRIPT_PATH,
  parseProbeResult,
  readAllProbeFiles,
  readProbeFile,
  type ProbeFiles,
} from "./probe.ts";
import { PLUGIN_ID, SETTINGS_PATH, type PrStatus } from "./types.ts";
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "./settings.ts";

interface CacheEntry {
  status?: PrStatus;
  settings?: Settings;
  settingsWarnings: string[];
  settingsError?: string;
  /** Browser-clock milliseconds of the last scratch-file refresh. */
  loadedAt: number;
  /** Browser-clock milliseconds of the last probe command completion. */
  probedAt: number;
  /** Browser-clock milliseconds of the last probe command start. */
  probeStartedAt: number;
  /** Consecutive probe command failures — drives the automatic backoff. */
  probeFailures: number;
  reading?: Promise<void>;
  probing?: Promise<void>;
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
const PROBE_TIMEOUT_MS = 25_000;
const MAX_ENTRIES = 32;

/**
 * Shared read-only entry returned for every non-selected workspace. Label
 * and panel callbacks run for every workspace on every host render, so a
 * frozen singleton avoids allocating a throwaway object each time.
 */
const COLD_ENTRY: CacheEntry = Object.freeze({
  settingsWarnings: [],
  loadedAt: 0,
  probedAt: 0,
  probeStartedAt: 0,
  probeFailures: 0,
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
  return await withTimeout(handle.completed, input.timeoutMs ?? PROBE_TIMEOUT_MS);
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

/**
 * Browser-side cache of probe results and settings, keyed per machine,
 * project and workspace. The singleton is shared by labels, the panel and
 * palette actions; file reads and probes are deduplicated per workspace.
 */
export class StatusCache {
  private readonly entries = new Map<string, CacheEntry>();

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
      void this.startRead(context, entry);
    }
    return entry;
  }

  /** Re-read the probe scratch files (and settings) without running commands. */
  async refreshFiles(context: WorkspaceContext): Promise<void> {
    const key = contextKey(context);
    const entry = this.entries.get(key) ?? this.evictAndCreate(key);
    entry.host = context.host;
    await this.startRead(context, entry);
  }

  /**
   * Run the probe script through a workspace terminal and refresh files.
   * Panel-only: label contexts have no terminal helper.
   *
   * Every probe spawns a terminal that pi-web keeps forever (no close API
   * yet — jmfederico/pi-web#225), so callers keep automatic probes bounded;
   * consecutive failures are counted here so the backoff can stretch the
   * retry interval instead of piling up hung ptys.
   */
  async probe(context: WorkspaceContext & { terminal?: TerminalLike }): Promise<void> {
    const key = contextKey(context);
    const entry = this.entries.get(key) ?? this.evictAndCreate(key);
    entry.host = context.host;
    if (entry.probing !== undefined) return await entry.probing;
    entry.probeStartedAt = nowMs();
    entry.probing = (async () => {
      let commandError: unknown;
      try {
        await this.ensureProbeScript(context);
        await runWorkspaceCommand(context, { title: "GitHub PR status", command: PROBE_COMMAND, op: "probe" });
      } catch (error) {
        commandError = error;
      } finally {
        entry.probedAt = nowMs();
        entry.probing = undefined;
      }
      if (commandError !== undefined) {
        entry.probeFailures += 1;
        throw commandError;
      }
      entry.probeFailures = 0;
      await this.startRead(context, entry);
    })();
    return await entry.probing;
  }

  /**
   * Write the probe script only when it is missing or different: a write
   * through the files API broadcasts a file mutation and auto-refreshes
   * pi-web's file explorer, which is pointless churn for a constant script.
   */
  private async ensureProbeScript(context: WorkspaceContext): Promise<void> {
    const existing = await readProbeFile((path) => context.files.readFile(path), PROBE_SCRIPT_PATH);
    if (existing === PROBE_SCRIPT) return;
    await context.files.writeFile(PROBE_SCRIPT_PATH, PROBE_SCRIPT, { overwrite: true });
  }

  private startRead(context: WorkspaceContext, entry: CacheEntry): Promise<void> {
    if (entry.reading !== undefined) return entry.reading;
    entry.reading = (async () => {
      try {
        // Read the probe files and settings concurrently: both are independent
        // reads that only converge in apply(), so doing them together shaves a
        // round-trip off every refresh without changing semantics.
        const [files, settingsResult] = await Promise.all([
          readAllProbeFiles((path) => context.files.readFile(path)),
          readSettings(context),
        ]);
        const status = parseProbeResult(files);
        this.apply(entry, status, settingsResult.settings, settingsResult.warnings, settingsResult.error);
      } catch (error) {
        entry.settingsError = error instanceof Error ? error.message : String(error);
      } finally {
        entry.loadedAt = nowMs();
        entry.reading = undefined;
      }
    })();
    return entry.reading;
  }

  private apply(entry: CacheEntry, status: PrStatus, settings: Settings, warnings: string[], settingsError?: string): void {
    entry.status = status;
    entry.settings = settings;
    entry.settingsWarnings = warnings;
    entry.settingsError = settingsError;
    const serialized = JSON.stringify([status, settings, warnings, settingsError]);
    const changed = entry.serialized !== serialized;
    entry.serialized = serialized;
    if (changed) entry.host?.requestRender();
  }

  private evictAndCreate(key: string): CacheEntry {
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = [...this.entries.entries()].sort((left, right) => left[1].loadedAt - right[1].loadedAt)[0];
      if (oldest !== undefined) this.entries.delete(oldest[0]);
    }
    const entry: CacheEntry = { settingsWarnings: [], loadedAt: 0, probedAt: 0, probeStartedAt: 0, probeFailures: 0 };
    this.entries.set(key, entry);
    return entry;
  }
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
