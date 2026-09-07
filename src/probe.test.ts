import { describe, expect, it } from "bun:test";
import { PROBE_COMMAND, PROBE_SCRIPT, parseProbeResult, probeFileReader, readAllProbeFiles } from "./probe.ts";
import type { PrStatus } from "./types.ts";

const GH_PR_JSON = JSON.stringify({
  number: 42,
  url: "https://github.com/acme/app/pull/42",
  title: "Add PR monitor",
  state: "OPEN",
  isDraft: false,
  author: { login: "gtrabanco" },
  headRefName: "feat/monitor",
  baseRefName: "main",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  statusCheckRollup: [
    { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/1" },
  ],
});

async function fixture(overrides: Partial<Record<string, string | undefined>> = {}) {
  return parseProbeResult(
    await readAllProbeFiles(
      probeFileReader({
        probe: '{"v":1,"ts":1700000000,"git":1}',
        branch: "feat/monitor\n",
        head: "abc1234567890abcdef1234567890abcdef1234\n",
        upstream: "origin/main\n",
        staged: "1\n",
        unstaged: "2\n",
        untracked: "3\n",
        aheadBehind: "0\t2\n",
        pr: GH_PR_JSON,
        ghErr: "",
        ...overrides,
      }),
    ),
  );
}

describe("parseProbeResult", () => {
  it("builds a full status from healthy probe files", async () => {
    const status = await fixture();
    expect(status.git).toBe(true);
    expect(status.probeAt).toBe(1_700_000_000);
    expect(status.branch).toBe("feat/monitor");
    expect(status.head).toBe("abc1234567890abcdef1234567890abcdef1234");
    expect(status.upstream).toBe("origin/main");
    expect(status.hasUpstream).toBe(true);
    expect(status.staged).toBe(1);
    expect(status.unstaged).toBe(2);
    expect(status.untracked).toBe(3);
    expect(status.ahead).toBe(2);
    expect(status.behind).toBe(0);
    expect(status.gh).toBe("ok");
    expect(status.pr).toMatchObject({ number: 42, state: "OPEN", author: "gtrabanco" });
    expect(status.ci.state).toBe("passed");
  });

  it("reports not-git workspaces without pr data", () => {
    const status = parseProbeResult({ probe: '{"v":1,"ts":123,"git":0}' });
    expect(status.git).toBe(false);
    expect(status.cold).toBe(false);
    expect(status.pr).toBeUndefined();
    expect(status.ci.state).toBe("none");
  });

  it("treats missing probe marker as never-probed cold state", () => {
    const status = parseProbeResult({});
    expect(status.git).toBe(false);
    expect(status.probeAt).toBeUndefined();
    expect(status.cold).toBe(true);
  });

  it("survives garbage files without throwing", async () => {
    const status = await fixture({
      probe: "not json{",
      staged: "x",
      aheadBehind: "garbage",
      pr: "{broken",
      ghErr: "boom",
    });
    expect(status.git).toBe(false);
    expect(status.cold).toBe(true);
    expect(status.pr).toBeUndefined();
    expect(status.gh).toBeUndefined();
  });

  it("parses counts of zero without upstream", async () => {
    const status = await fixture({ probe: '{"v":1,"ts":9,"git":1}', upstream: "", aheadBehind: undefined });
    expect(status.hasUpstream).toBe(false);
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });

  it("handles detached HEAD (branch.txt contains HEAD)", async () => {
    const status = await fixture({ branch: "HEAD\n" });
    expect(status.branch).toBe("HEAD");
  });

  it("classifies gh-not-found from gh.err", async () => {
    const status = await fixture({ pr: undefined, ghErr: "gh: command not found" });
    expect(status.gh).toBe("missing");
    expect(status.pr).toBeUndefined();
  });

  it("classifies unauthenticated gh from gh.err", async () => {
    const status = await fixture({
      pr: undefined,
      ghErr: "gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable. To log in, run: gh auth login",
    });
    expect(status.gh).toBe("unauthenticated");
  });

  it("classifies no-pr as ok without a pr object", async () => {
    const status = await fixture({ pr: undefined, ghErr: "no pull requests found for branch" });
    expect(status.gh).toBe("ok");
    expect(status.pr).toBeUndefined();
  });

  it("marks pr closed and ignores ci for closed prs", async () => {
    const pr = JSON.stringify({ ...JSON.parse(GH_PR_JSON), state: "MERGED", statusCheckRollup: [] });
    const status = await fixture({ pr });
    expect(status.pr?.state).toBe("MERGED");
    expect(status.ci.state).toBe("none");
  });

  it("rejects hostile pr json shapes", async () => {
    for (const bad of ["null", "42", '"str"', "{}", '{"number":"x"}', '{"number":1,"url":"javascript:alert(1)"}']) {
      const status = await fixture({ pr: bad });
      if (status.pr !== undefined) {
        expect(status.pr.url.startsWith("https://")).toBe(true);
        expect(typeof status.pr.number).toBe("number");
      }
    }
    expect((await fixture({ pr: '{"number":"x"}' })).pr).toBeUndefined();
    expect((await fixture({ pr: '{"number":1,"url":"javascript:alert(1)"}' })).pr).toBeUndefined();
  });

  it("normalizes trailing whitespace in branch names", async () => {
    const status = await fixture({ branch: "  feat/monitor  \n" });
    expect(status.branch).toBe("feat/monitor");
  });
});

describe("probe artifacts", () => {
  it("uses a single static command without interpolated user input", () => {
    expect(PROBE_COMMAND).toBe("sh .pi-web/github-pr/probe.sh");
    expect(PROBE_COMMAND.includes("'")).toBe(false);
  });

  it("probe script is POSIX sh, writes the marker last and exits 0", () => {
    expect(PROBE_SCRIPT.startsWith("#!/bin/sh")).toBe(true);
    expect(PROBE_SCRIPT.includes("exit 0")).toBe(true);
    const markerIndex = PROBE_SCRIPT.indexOf("probe.json");
    expect(markerIndex).toBeGreaterThan(0);
    // marker (probe.json) must be referenced after every other scratch file write
    for (const name of ["branch.txt", "head.txt", "upstream.txt", "staged.txt", "unstaged.txt", "untracked.txt", "pr.json", "gh.err"]) {
      const firstUse = PROBE_SCRIPT.indexOf(name);
      expect(firstUse, name).toBeGreaterThanOrEqual(0);
      if (name !== "gh.err") expect(firstUse, `${name} before marker`).toBeLessThan(markerIndex);
    }
  });

  it("probe script excludes its own scratch dir from untracked counts", () => {
    expect(PROBE_SCRIPT).toContain("git ls-files --others");
    expect(PROBE_SCRIPT).toContain("--exclude=.pi-web/github-pr/");
  });

  it("probe script computes ahead/behind against the upstream", () => {
    expect(PROBE_SCRIPT).toContain('git rev-list --left-right --count "@{u}"..."HEAD"');
  });
});

describe("prStatus helpers", () => {
  it("isDirty and unpushed derive from counts", async () => {
    const status = await fixture();
    expect(status.isDirty).toBe(true);
    expect(status.unpushed).toBe(true);
    const clean: PrStatus = { ...status, staged: 0, unstaged: 0, untracked: 0, ahead: 0 };
    expect(clean.isDirty).toBe(true);
  });

  it("unpushed is true without upstream", async () => {
    const status = await fixture({ upstream: "", aheadBehind: undefined });
    expect(status.unpushed).toBe(true);
  });
});
