import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROBE_SCRIPT, parseProbeResult } from "./probe.ts";
import { PROBE_FILE_PATHS } from "./probe.ts";

/**
 * Integration test: executes the real probe script with /bin/sh inside a
 * real git repository. Runs locally (no CI) — skipped automatically when
 * git or sh are unavailable.
 */

let workDir: string | undefined;

const shAvailable = typeof (await Bun.which("sh")) === "string";
const gitAvailable = typeof (await Bun.which("git")) === "string";

async function sh(script: string, cwd: string): Promise<void> {
  const proc = Bun.spawn(["sh", "-c", script], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`sh exited ${String(code)}: ${stderr || stdout}`);
}

async function git(args: string, cwd: string): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", `git ${args}`], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args} exited ${String(code)}: ${stderr}`);
  return stdout;
}

async function probe(): Promise<ReturnType<typeof parseProbeResult>> {
  const work = workDir;
  if (work === undefined) throw new Error("workDir missing");
  await sh(PROBE_SCRIPT, work);
  const contents = await Promise.all(
    Object.values(PROBE_FILE_PATHS).map(async (path) => {
      try {
        return await readFile(join(work, path), "utf8");
      } catch {
        return undefined;
      }
    }),
  );
  const [probeMarker, branch, head, upstream, staged, unstaged, untracked, aheadBehind, pr, ghErr] = contents;
  return parseProbeResult({ probe: probeMarker, branch, head, upstream, staged, unstaged, untracked, aheadBehind, pr, ghErr });
}

describe.skipIf(!shAvailable || !gitAvailable)("probe script integration", () => {
  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ghpr-probe-"));
    await sh("git init -b main && git config user.email t@t && git config user.name t", workDir);
    await writeFile(join(workDir, "README.md"), "# test\n");
    await sh("git add README.md && git commit -m init --quiet", workDir);
  });

  afterAll(async () => {
    if (workDir !== undefined) await rm(workDir, { recursive: true, force: true });
  });

  it("reports a clean main branch with no upstream", async () => {
    const status = await probe();
    expect(status.git).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.hasUpstream).toBe(false);
    expect(status.staged).toBe(0);
    expect(status.unstaged).toBe(0);
    expect(status.untracked).toBe(0);
    expect(status.isDirty).toBe(false);
  });

  it("counts staged, unstaged and untracked changes", async () => {
    const work = workDir;
    if (work === undefined) throw new Error("workDir missing");
    await writeFile(join(work, "tracked.txt"), "new\n");
    await sh("git add tracked.txt", work);
    await writeFile(join(work, "modified.txt"), "changed\n");
    await sh("git add modified.txt && git commit -m add --quiet", work);
    await writeFile(join(work, "modified.txt"), "changed again\n");
    await writeFile(join(work, "untracked.txt"), "hi\n");

    const status = await probe();
    expect(status.staged).toBe(0);
    expect(status.unstaged).toBe(1);
    expect(status.untracked).toBe(1);
    expect(status.isDirty).toBe(true);
  });

  it("excludes its own scratch dir from untracked counts", async () => {
    const status = await probe();
    // scratch files exist but must not be counted as untracked
    expect(status.untracked).toBe(1);
  });

  it("reports ahead/behind against an upstream", async () => {
    const work = workDir;
    if (work === undefined) throw new Error("workDir missing");
    const bareDir = `${work}-bare`;
    await sh(`git init --bare -b main ${JSON.stringify(bareDir)}`, work);
    await sh(`git remote add origin ${JSON.stringify(bareDir)} && git push -u origin main --quiet`, work);
    let status = await probe();
    expect(status.hasUpstream).toBe(true);
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);

    await writeFile(join(work, "more.txt"), "x\n");
    await sh("git add more.txt && git commit -m more --quiet", work);
    status = await probe();
    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(0);
    expect(status.unpushed).toBe(true);
  });

  it("classifies gh availability without auth in sandbox", async () => {
    const status = await probe();
    // gh exists but is not authenticated in this environment; either way it
    // must not crash the probe and must produce a valid gh classification.
    expect(["ok", "missing", "unauthenticated", "error"] as (string | undefined)[]).toContain(status.gh);
  });

  it("marks non-git directories", async () => {
    const plain = await mkdtemp(join(tmpdir(), "ghpr-plain-"));
    try {
      await sh(PROBE_SCRIPT, plain);
      const marker = await readFile(join(plain, ".pi-web/github-pr/probe.json"), "utf8");
      const status = parseProbeResult({ probe: marker });
      expect(status.git).toBe(false);
      expect(status.cold).toBe(false);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});
