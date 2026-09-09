import { describe, expect, it } from "bun:test";
import { handleWorkerMessage, type WorkerRequest } from "./statusWorker.ts";
import { createStatusParser, inlineParser } from "./workerClient.ts";
import type { ProbeFiles } from "./probe.ts";

const FILES: ProbeFiles = {
  probe: '{"v":1,"ts":1700000000,"git":1}',
  branch: "feat/monitor\n",
  upstream: "origin/main\n",
  staged: "1\n",
  unstaged: "0\n",
  untracked: "0\n",
  aheadBehind: "0\t2\n",
  pr: JSON.stringify({
    number: 42,
    url: "https://github.com/acme/app/pull/42",
    title: "Add PR monitor",
    state: "OPEN",
    isDraft: false,
    statusCheckRollup: [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/1" }],
  }),
  ghErr: "",
};

describe("inlineParser", () => {
  it("parses and serializes the status off the raw files", async () => {
    const { status, serialized } = await inlineParser(FILES);
    expect(status.pr?.number).toBe(42);
    expect(status.ahead).toBe(2);
    expect(serialized).toBe(JSON.stringify(status));
    expect(JSON.parse(serialized)).toEqual(status);
  });
});

describe("handleWorkerMessage", () => {
  it("answers a valid request with ok + status + serialized", () => {
    const request: WorkerRequest = { id: 7, files: FILES };
    const response = handleWorkerMessage(request);
    expect(response.id).toBe(7);
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.status.pr?.number).toBe(42);
      expect(response.serialized).toBe(JSON.stringify(response.status));
    }
  });

  it("answers malformed input with an error response instead of throwing", () => {
    for (const bad of [undefined, null, 42, {}, { id: "x", files: FILES }, { id: 1 }]) {
      const response = handleWorkerMessage(bad);
      expect(response.ok).toBe(false);
      if (!response.ok) expect(typeof response.error).toBe("string");
    }
  });
});

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  posted: unknown[] = [];
  terminate(): void {
    /* noop */
  }
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
    const response = handleWorkerMessage((message as { files?: unknown }).files === undefined ? undefined : message);
    queueMicrotask(() => this.onmessage?.({ data: response }));
  }
}

describe("createStatusParser", () => {
  it("routes parsing through the worker when one is available", async () => {
    FakeWorker.instances.length = 0;
    const parser = createStatusParser({ createWorker: () => new FakeWorker() as unknown as Worker });
    const { status, serialized } = await parser(FILES);
    expect(status.pr?.number).toBe(42);
    expect(serialized).toBe(JSON.stringify(status));
    expect(FakeWorker.instances).toHaveLength(1);
    parser.dispose();
  });

  it("reuses a single worker across calls", async () => {
    FakeWorker.instances.length = 0;
    const parser = createStatusParser({ createWorker: () => new FakeWorker() as unknown as Worker });
    await parser(FILES);
    await parser(FILES);
    expect(FakeWorker.instances).toHaveLength(1);
    parser.dispose();
  });

  it("falls back to inline parsing when the worker construction throws", async () => {
    const parser = createStatusParser({
      createWorker: () => {
        throw new Error("Workers unavailable");
      },
    });
    const { status, serialized } = await parser(FILES);
    expect(status.pr?.number).toBe(42);
    expect(serialized).toBe(JSON.stringify(status));
    parser.dispose();
  });

  it("falls back to inline parsing after a worker timeout", async () => {
    class SilentWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      terminate(): void {
        /* noop */
      }
      postMessage(): void {
        /* never answers */
      }
    }
    const parser = createStatusParser({ createWorker: () => new SilentWorker() as unknown as Worker, timeoutMs: 20 });
    const started = Date.now();
    const { status } = await parser(FILES);
    expect(status.pr?.number).toBe(42);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    parser.dispose();
  });

  it("falls back permanently after a worker error", async () => {
    FakeWorker.instances.length = 0;
    const parser = createStatusParser({ createWorker: () => new FakeWorker() as unknown as Worker, timeoutMs: 20 });
    const first = await parser(FILES);
    FakeWorker.instances[0]?.onerror?.();
    // worker marked dead: next call resolves inline without touching a worker
    const second = await parser(FILES);
    expect(second.status.pr?.number).toBe(first.status.pr?.number);
    expect(FakeWorker.instances).toHaveLength(1);
    parser.dispose();
  });
});
