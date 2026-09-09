import { parseProbeResult, type ProbeFiles } from "./probe.ts";
import type { PrStatus } from "./types.ts";

/**
 * Worker-side half of the status parser. Parsing `pr.json` (whose CI rollup
 * can be large) and serializing the result happens here, off the page's main
 * thread; the main thread only string-compares and calls requestRender.
 */

export interface WorkerRequest {
  id: number;
  files: ProbeFiles;
}

export type WorkerResponse =
  | { id: number; ok: true; status: PrStatus; serialized: string }
  | { id: number; ok: false; error: string };

export interface ParsedStatus {
  status: PrStatus;
  serialized: string;
}

/** Parse raw probe files into a status plus its JSON serialization. */
export function parseStatusPayload(files: ProbeFiles): ParsedStatus {
  const status = parseProbeResult(files);
  return { status, serialized: JSON.stringify(status) };
}

/** Total handler: never throws, always answers with a WorkerResponse. */
export function handleWorkerMessage(message: unknown): WorkerResponse {
  const request = message as Partial<WorkerRequest> | null | undefined;
  if (typeof request?.id !== "number" || !Number.isFinite(request.id) || typeof request.files !== "object" || request.files === null) {
    return { id: -1, ok: false, error: "malformed worker request" };
  }
  try {
    const { status, serialized } = parseStatusPayload(request.files as ProbeFiles);
    return { id: request.id, ok: true, status, serialized };
  } catch (error) {
    return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Attach the message handler only inside a real worker scope: the same module
// is imported by tests and by the inline fallback, where `self` exists but is
// not a WorkerGlobalScope.
declare const WorkerGlobalScope: abstract new (...args: never[]) => unknown;
const inWorkerScope = typeof WorkerGlobalScope !== "undefined" && typeof self !== "undefined" && self instanceof WorkerGlobalScope;
if (inWorkerScope) {
  (self as unknown as { onmessage: (event: { data: unknown }) => void }).onmessage = (event) => {
    const response = handleWorkerMessage(event.data);
    (self as unknown as { postMessage: (message: WorkerResponse) => void }).postMessage(response);
  };
}
