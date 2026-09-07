import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statusCache } from "./cache.ts";
import { labelDescriptors } from "./labels.ts";
import { PROBE_COMMAND } from "./probe.ts";
import type { PrStatus } from "./types.ts";

/**
 * End-to-end test of the browser-side cache without a browser: a fake
 * workspace context backed by the real filesystem and a real `sh` terminal.
 * Exercises cache.probe -> scratch files -> parse -> labels.
 */

const shAvailable = typeof (await Bun.which("sh")) === "string";
const gitAvailable = typeof (await Bun.which("git")) === "string";

let repo: string | undefined;

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
        return { path, size: content.length, modifiedAt: new Date().toISOString() };
      },
    },
    terminal: {
      runCommand: async (input: { title: string; command: string; open?: boolean }) => {
        expect(input.command).toBe(PROBE_COMMAND);
        expect(input.open).toBe(false);
        const proc = Bun.spawn(["sh", "-c", input.command], { cwd: work, stdout: "pipe", stderr: "pipe" });
        const code = await proc.exited;
        const run = {
          id: "run-1",
          origin: "github-pr-status",
          projectId: "p1",
          workspaceId: "ws1",
          terminalId: "term-1",
          title: input.title,
          command: input.command,
          status: code === 0 ? ("succeeded" as const) : ("failed" as const),
          exitCode: code,
          createdAt: new Date().toISOString(),
          metadata: {},
        };
        return { run, completed: Promise.resolve(run) };
      },
    },
    host: { requestRender: () => { renders += 1; } },
  };
}

let renders = 0;

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

  it("probe -> files -> parsed status (unpushed commit detected)", async () => {
    const context = makeContext(true);
    await statusCache.probe(context as never, { force: true });
    const status: PrStatus | undefined = statusCache.entryStatus(context as never);
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
    statusCache.ensureLoaded(context as never);
    const status = statusCache.entryStatus(context as never);
    expect(labelDescriptors(status, true)).toEqual([]);
  });

  it("ensureLoaded skips non-selected workspaces", () => {
    const context = makeContext(false);
    context.workspace = { id: "ws-other", projectId: "p-other", path: context.workspace.path, label: "other", isMain: false };
    const entry = statusCache.ensureLoaded(context as never);
    expect(entry.status).toBeUndefined();
    expect(entry.loadedAt).toBe(0);
  });

  it("statusByKey serves palette actions", async () => {
    const context = makeContext(true);
    expect(statusCache.statusByKey("local", "p1", "ws1")?.ahead).toBe(1);
    expect(statusCache.statusByKey("other-machine", "p1", "ws1")).toBeUndefined();
  });
});
