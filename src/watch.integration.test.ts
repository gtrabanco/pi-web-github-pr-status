import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WATCH_SCRIPT, WATCHER_STATE_PATH, parseWatcherState } from "./watch.ts";
import { PROBE_FILE_PATHS, parseProbeResult } from "./probe.ts";

/**
 * Integration test: executes the real watch script with /bin/sh inside a
 * real git repository. Runs locally (no CI) — skipped automatically when
 * git or sh are unavailable. Covers both modes: `once` (single cycle) and
 * the daemon loop (interval cadence + stop file + self-removal).
 */

let workDir: string | undefined;

const shAvailable = typeof (await Bun.which("sh")) === "string";
const gitAvailable = typeof (await Bun.which("git")) === "string";

async function runScript(script: string, cwd: string, scriptArgs: string[] = [], timeoutMs = 20_000): Promise<number> {
  // `sh -c SCRIPT name args...`: the first argument after the script is $0.
  const proc = Bun.spawn(["sh", "-c", script, "ghpr-watch", ...scriptArgs], { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`sh exited ${String(code)}: ${stderr || stdout}`);
  return code;
}

async function readMarker(cwd: string): Promise<string | undefined> {
  try {
    return await readFile(join(cwd, ".pi-web/github-pr/probe.json"), "utf8");
  } catch {
    return undefined;
  }
}

async function runOnce(cwd: string): Promise<ReturnType<typeof parseProbeResult>> {
  await runScript(WATCH_SCRIPT, cwd, ["once"]);
  const contents = await Promise.all(
    Object.values(PROBE_FILE_PATHS).map(async (path) => {
      try {
        return await readFile(join(cwd, path), "utf8");
      } catch {
        return undefined;
      }
    }),
  );
  const [probeMarker, branch, head, upstream, staged, unstaged, untracked, aheadBehind, pr, ghErr] = contents;
  return parseProbeResult({ probe: probeMarker, branch, head, upstream, staged, unstaged, untracked, aheadBehind, pr, ghErr });
}

describe.skipIf(!shAvailable || !gitAvailable)("watch script integration", () => {
  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ghpr-watch-"));
    await runScript("git init -b main && git config user.email t@t && git config user.name t", workDir);
    await writeFile(join(workDir, "README.md"), "# test\n");
    await runScript("git add README.md && git commit -m init --quiet", workDir);
  });

  afterAll(async () => {
    if (workDir !== undefined) await rm(workDir, { recursive: true, force: true });
  });

  it("once mode reports a clean main branch with no upstream", async () => {
    const status = await runOnce(workDir!);
    expect(status.git).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.hasUpstream).toBe(false);
    expect(status.staged).toBe(0);
    expect(status.unstaged).toBe(0);
    expect(status.untracked).toBe(0);
    expect(status.isDirty).toBe(false);
  });

  it("once mode counts staged, unstaged and untracked changes", async () => {
    const work = workDir!;
    await writeFile(join(work, "tracked.txt"), "new\n");
    await runScript("git add tracked.txt", work);
    await writeFile(join(work, "modified.txt"), "changed\n");
    await runScript("git add modified.txt && git commit -m add --quiet", work);
    await writeFile(join(work, "modified.txt"), "changed again\n");
    await writeFile(join(work, "untracked.txt"), "hi\n");

    const status = await runOnce(work);
    expect(status.staged).toBe(0);
    expect(status.unstaged).toBe(1);
    expect(status.untracked).toBe(1);
    expect(status.isDirty).toBe(true);
  });

  it("excludes its own scratch dir from untracked counts", async () => {
    const status = await runOnce(workDir!);
    expect(status.untracked).toBe(1);
  });

  it("reports ahead/behind against an upstream", async () => {
    const work = workDir!;
    await runScript('git init --bare -b main "$PWD-bare"', work);
    await runScript('git remote add origin "$PWD-bare" && git push -u origin main --quiet', work);
    let status = await runOnce(work);
    expect(status.hasUpstream).toBe(true);
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);

    await writeFile(join(work, "more.txt"), "x\n");
    await runScript("git add more.txt && git commit -m more --quiet", work);
    status = await runOnce(work);
    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(0);
    expect(status.unpushed).toBe(true);
  });

  it("classifies gh availability without auth in sandbox", async () => {
    const status = await runOnce(workDir!);
    expect(["ok", "missing", "unauthenticated", "error"] as (string | undefined)[]).toContain(status.gh);
  });

  it("marks non-git directories", async () => {
    const plain = await mkdtemp(join(tmpdir(), "ghpr-plain-"));
    try {
      await runScript(WATCH_SCRIPT, plain, ["once"]);
      const marker = await readFile(join(plain, ".pi-web/github-pr/probe.json"), "utf8");
      const status = parseProbeResult({ probe: marker });
      expect(status.git).toBe(false);
      expect(status.cold).toBe(false);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("daemon mode cycles on the interval and exits on the stop file", async () => {
    const work = workDir!;
    await writeFile(join(work, ".pi-web/github-pr/interval.txt"), "1\n");
    const proc = Bun.spawn(["sh", "-c", WATCH_SCRIPT, "ghpr-watch"], { cwd: work, stdout: "pipe", stderr: "pipe" });
    try {
      // Two cycles at a 1s interval (2s slices → up to ~4s each cycle end).
      await new Promise((resolve) => setTimeout(resolve, 5_500));
      const first = await readMarker(work);
      expect(first).toBeDefined();
      const state = parseWatcherState(await readFile(join(work, WATCHER_STATE_PATH), "utf8"));
      expect(state.pid).toBeNumber();
      expect(state.interval).toBe(1);
      const before = JSON.parse(first!) as { ts: number };
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      const second = JSON.parse((await readMarker(work))!) as { ts: number };
      expect(second.ts).toBeGreaterThan(before.ts);

      // Stop file: the watcher must exit and remove its state file.
      await writeFile(join(work, ".pi-web/github-pr/stop"), "1\n");
      const exitCode = await Promise.race([
        proc.exited.then((code) => code),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 6_000)),
      ]);
      expect(exitCode).toBe(0);
      await expect(readFile(join(work, WATCHER_STATE_PATH), "utf8")).rejects.toThrow();
    } finally {
      proc.kill();
    }
  }, 20_000);

  it("daemon mode exits immediately with interval 0", async () => {
    const work = workDir!;
    await writeFile(join(work, ".pi-web/github-pr/interval.txt"), "0\n");
    const proc = Bun.spawn(["sh", "-c", WATCH_SCRIPT, "ghpr-watch"], { cwd: work, stdout: "pipe", stderr: "pipe" });
    const code = await Promise.race([
      proc.exited.then((value) => value),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 4_000)),
    ]);
    expect(code).toBe(0);
    await expect(readFile(join(work, WATCHER_STATE_PATH), "utf8")).rejects.toThrow();
  }, 10_000);
});
