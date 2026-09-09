import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inlineParser } from "./workerClient.ts";
import { StatusCache } from "./cache.ts";
import { TRIGGER_PATH, WATCH_COMMAND, WATCH_SCRIPT, WATCH_SCRIPT_PATH } from "./watch.ts";
import { labelDescriptors } from "./labels.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import type { PrStatus } from "./types.ts";

/**
 * End-to-end test of the browser-side cache without a browser: a fake
 * workspace context backed by the real filesystem and a real `sh` terminal.
 * Exercises the full watcher flow: spawn → once-cycle equivalent (trigger)
 * -> scratch files -> worker-or-inline parse -> labels. The fake terminal
 * runs the watcher in `once` mode whenever the browser writes the trigger
 * file, mirroring how a real watcher daemon consumes it.
 */

const shAvailable = typeof (await Bun.which("sh")) === "string";
const gitAvailable = typeof (await Bun.which("git")) === "string";

let repo: string | undefined;

let renders = 0;

function makeContext(selected: boolean) {
  const work = repo;
  if (work === undefined) throw new Error("repo missing");
  return {
    machine: { id: "local", name: "local", kind: "local" as const },
    workspace: { id: "ws1", projectId: "p1", path: work, label: "main", isMain: true },
    state: selected ? { selectedWorkspace: { id: "ws1", projectId: "p1" } } : {},
    files: {
      readFile: async (path: string) => {
        const info = await stat(join(work, path));
        const content = await readFile(join(work, path), "utf8");
        return { path, content, binary: false, size: info.size, encoding: "utf8" as const, truncated: false, modifiedAt: new Date(info.mtime).toISOString() };
      },
      writeFile: async (path: string, content: string | Uint8Array) => {
        await Bun.write(join(work, path), content);
        if (path === TRIGGER_PATH) void Bun.spawn(["sh", "-c", WATCH_SCRIPT, "ghpr-watch", "once"], { cwd: work, stdout: "pipe", stderr: "pipe" }).exited;
        return { path, size: content.length, modifiedAt: new Date().toISOString(), created: true };
      },
      deleteFile: async (path: string) => {
        await rm(join(work, path), { force: true });
        return { path, existed: true };
      },
    },
    terminal: {
      runCommand: async (input: { title: string; command: string; open?: boolean }) => {
        expect(input.command).toBe(WATCH_COMMAND);
        expect(input.open).toBe(false);
        // A real watcher daemon never completes; simulate with a pending promise.
        void Bun.spawn(["sh", "-c", WATCH_SCRIPT, "ghpr-watch", "once"], { cwd: work, stdout: "pipe", stderr: "pipe" }).exited;
        const run = {
          id: "run-1",
          origin: "github-pr-status",
          projectId: "p1",
          workspaceId: "ws1",
          terminalId: "term-1",
          title: input.title,
          command: input.command,
          status: "succeeded" as const,
          createdAt: new Date().toISOString(),
          metadata: {},
        };
        return { run, completed: new Promise<typeof run>(() => undefined) };
      },
    },
    host: { requestRender: () => { renders += 1; } },
  };
}

describe.skipIf(!shAvailable || !gitAvailable)("status cache e2e", () => {
  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "ghpr-cache-"));
    const sh = async (script: string): Promise<void> => {
      const proc = Bun.spawn(["sh", "-c", script], { cwd: repo, stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      if (code !== 0) throw new Error(`sh failed: ${script}`);
    };
    await sh("git init -q -b main && git config user.email t@t && git config user.name t");
    await Bun.write(join(repo, "README.md"), "# t\n");
    await sh("git add README.md && git commit -q -m init");
    await sh(`git init -q --bare -b main ${JSON.stringify(`${repo}-bare`)}`);
    await sh(`git remote add origin ${JSON.stringify(`${repo}-bare`)} && git push -q -u origin main`);
    await Bun.write(join(repo, "more.txt"), "x\n");
    await sh("git add more.txt && git commit -q -m more");
  });

  afterAll(async () => {
    if (repo !== undefined) await rm(repo, { recursive: true, force: true });
    if (repo !== undefined) await rm(`${repo}-bare`, { recursive: true, force: true });
  });

  it("watcher spawn -> trigger cycle -> files -> parsed status (unpushed commit detected)", async () => {
    const context = makeContext(true);
    const cache = new StatusCache(inlineParser);
    cache.ensureLoaded(context as never);
    await cache.ensureWatcher(context as never, DEFAULT_SETTINGS);
    const completed = await cache.requestCycleAndWait(context as never, 10_000);
    expect(completed).toBe(true);
    const status: PrStatus | undefined = cache.entryStatus(context as never);
    expect(status).toBeDefined();
    expect(status?.git).toBe(true);
    expect(status?.branch).toBe("main");
    expect(status?.hasUpstream).toBe(true);
    expect(status?.ahead).toBe(1);
    expect(status?.behind).toBe(0);
    expect(status?.unpushed).toBe(true);
    expect(status?.isDirty).toBe(false);
    expect(renders).toBeGreaterThan(0);
  });

  it("labels stay quiet without an open PR", async () => {
    const context = makeContext(true);
    const cache = new StatusCache(inlineParser);
    cache.ensureLoaded(context as never);
    await cache.requestCycleAndWait(context as never, 10_000);
    const status = cache.entryStatus(context as never);
    expect(labelDescriptors(status, true)).toEqual([]);
  });

  it("ensureLoaded skips non-selected workspaces", () => {
    const context = makeContext(false);
    context.workspace = { id: "ws-other", projectId: "p-other", path: context.workspace.path, label: "other", isMain: false };
    const cache = new StatusCache(inlineParser);
    const entry = cache.ensureLoaded(context as never);
    expect(entry.status).toBeUndefined();
    expect(entry.loadedAt).toBe(0);
  });

  it("statusByKey serves palette actions", async () => {
    const context = makeContext(true);
    const cache = new StatusCache(inlineParser);
    await cache.requestCycleAndWait(context as never, 10_000);
    expect(cache.statusByKey("local", "p1", "ws1")?.ahead).toBe(1);
    expect(cache.statusByKey("other-machine", "p1", "ws1")).toBeUndefined();
  });
});
