import { parseProbeResult, type ProbeFiles } from "./probe.ts";
import { handleWorkerMessage, type ParsedStatus, type WorkerResponse } from "./statusWorker.ts";
import type { PrStatus } from "./types.ts";

/**
 * Main-thread client for the status parser worker. Parses run in a module
 * worker; any failure (worker unavailable, construction error, timeout,
 * worker error) permanently degrades to inline parsing so status refreshes
 * always complete. A single worker instance is shared by all callers.
 */

export type StatusParser = (files: ProbeFiles) => Promise<ParsedStatus>;

/** In-thread parser used as fallback and by tests. */
export async function inlineParser(files: ProbeFiles): Promise<ParsedStatus> {
  const status: PrStatus = parseProbeResult(files);
  return { status, serialized: JSON.stringify(status) };
}

export interface StatusParserOptions {
  /** Worker factory override (tests). Defaults to a module worker by URL. */
  createWorker?: () => Worker;
  /** Per-request timeout before falling back to inline parsing. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export interface DisposableStatusParser extends StatusParser {
  dispose(): void;
}

export function createStatusParser(options: StatusParserOptions = {}): DisposableStatusParser {
  const { createWorker, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  let worker: Worker | undefined;
  let broken = false;
  let nextId = 1;

  const dispose = (): void => {
    worker?.terminate();
    worker = undefined;
    broken = true;
  };

  const parse: StatusParser = async (files) => {
    if (!broken) {
      try {
        worker ??= createWorker === undefined ? new Worker(new URL("./statusWorker.js", import.meta.url), { type: "module" }) : createWorker();
        const active = worker;
        return await new Promise<ParsedStatus>((resolve, reject) => {
          const id = nextId++;
          let settled = false;
          const finish = (value: ParsedStatus): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
          };
          const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          };
          const timer = setTimeout(() => {
            // A wedged worker must not stall status refreshes forever.
            broken = true;
            dispose();
            reject(new Error("status worker timed out"));
          }, timeoutMs);
          active.onmessage = (event: MessageEvent) => {
            const response = event.data as WorkerResponse | undefined;
            if (response !== undefined && response.id === id) {
              if (response.ok) finish({ status: response.status, serialized: response.serialized });
              else fail(new Error(response.error));
            }
          };
          active.onerror = () => {
            broken = true;
            dispose();
            fail(new Error("status worker crashed"));
          };
          active.postMessage({ id, files } satisfies { id: number; files: ProbeFiles });
        });
      } catch {
        broken = true;
        dispose();
      }
    }
    return await inlineParser(files);
  };

  return Object.assign(parse, { dispose });
}
