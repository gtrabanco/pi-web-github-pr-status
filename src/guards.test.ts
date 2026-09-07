import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS, type Settings } from "./settings.ts";
import { evaluateClose, evaluateMerge, buildMergeCommand, buildCloseCommand, explainCiState } from "./guards.ts";
import type { PrStatus } from "./types.ts";

function baseStatus(overrides: Partial<PrStatus> = {}): PrStatus {
  return {
    git: true,
    branch: "feat/x",
    staged: 0,
    unstaged: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
    hasUpstream: true,
    ci: { state: "none", total: 0, passed: 0, running: 0, failed: 0, checks: [] },
    ...overrides,
  };
}

function openPr(overrides: Record<string, unknown> = {}): NonNullable<PrStatus["pr"]> {
  return {
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    title: "Add PR monitor",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    ...overrides,
  };
}

const safeSettings: Settings = {
  showCI: true,
  refreshSeconds: 90,
  merge: { enabled: true, method: "merge", requireCleanWorktree: true, requireCI: true, deleteBranch: false },
};

describe("evaluateMerge", () => {
  it("is fully clear for a clean, pushed, green, open PR", () => {
    const result = evaluateMerge(baseStatus({ pr: openPr() }), safeSettings);
    expect(result.canMerge).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.confirmations).toEqual([]);
  });

  it("blocks when merge feature is disabled by settings", () => {
    const result = evaluateMerge(baseStatus({ pr: openPr() }), { ...safeSettings, merge: { ...safeSettings.merge, enabled: false } });
    expect(result.canMerge).toBe(false);
    expect(result.blockers).toEqual(["One-click merge is disabled in this workspace's plugin settings"]);
  });

  it("blocks when there is no PR or the PR is not open", () => {
    expect(evaluateMerge(baseStatus(), safeSettings).canMerge).toBe(false);
    expect(evaluateMerge(baseStatus({ pr: openPr({ state: "MERGED" }) }), safeSettings).blockers).toEqual(["Pull request #7 is already merged"]);
    expect(evaluateMerge(baseStatus({ pr: openPr({ state: "CLOSED" }) }), safeSettings).blockers).toEqual(["Pull request #7 is closed"]);
  });

  it("blocks when the worktree is dirty and the clean-worktree guard is enabled", () => {
    const dirty = baseStatus({ pr: openPr(), staged: 1, untracked: 2 });
    const result = evaluateMerge(dirty, safeSettings);
    expect(result.canMerge).toBe(false);
    expect(result.blockers).toEqual(["Worktree has uncommitted changes (1 staged, 0 unstaged, 2 untracked)"]);

    const relaxed: Settings = { ...safeSettings, merge: { ...safeSettings.merge, requireCleanWorktree: false } };
    const relaxedResult = evaluateMerge(dirty, relaxed);
    expect(relaxedResult.canMerge).toBe(true);
    expect(relaxedResult.blockers).toEqual([]);
  });

  it("blocks unpushed commits and missing upstream", () => {
    const unpushed = baseStatus({ pr: openPr(), ahead: 2 });
    expect(evaluateMerge(unpushed, safeSettings).blockers).toEqual(["2 local commit(s) not pushed"]);

    const noUpstream = baseStatus({ pr: openPr(), hasUpstream: false, upstream: undefined });
    const result = evaluateMerge(noUpstream, safeSettings);
    expect(result.canMerge).toBe(false);
    expect(result.blockers).toEqual(["Branch has no upstream — publish it first (git push -u)"]);
  });

  it("does not block when local branch is only behind upstream", () => {
    const result = evaluateMerge(baseStatus({ pr: openPr(), behind: 3 }), safeSettings);
    expect(result.canMerge).toBe(true);
    expect(result.confirmations).toEqual(["Local branch is 3 commit(s) behind its upstream"]);
  });

  it("requires confirmation while CI is running or failed (when CI guard is on)", () => {
    const running = baseStatus({ pr: openPr(), ci: { state: "running", total: 3, passed: 1, running: 2, failed: 0, checks: [] } });
    expect(evaluateMerge(running, safeSettings).confirmations).toEqual(["CI is still running (1 passed, 2 running)"]);

    const failed = baseStatus({ pr: openPr(), ci: { state: "failed", total: 3, passed: 1, running: 0, failed: 2, checks: [] } });
    expect(evaluateMerge(failed, safeSettings).confirmations).toEqual(["CI has failures (2 failed)"]);

    const passed = baseStatus({ pr: openPr(), ci: { state: "passed", total: 2, passed: 2, running: 0, failed: 0, checks: [] } });
    expect(evaluateMerge(passed, safeSettings).confirmations).toEqual([]);
  });

  it("skips the CI confirmation when the CI guard is disabled", () => {
    const failed = baseStatus({ pr: openPr(), ci: { state: "failed", total: 1, passed: 0, running: 0, failed: 1, checks: [] } });
    const relaxed: Settings = { ...safeSettings, merge: { ...safeSettings.merge, requireCI: false } };
    expect(evaluateMerge(failed, relaxed).confirmations).toEqual([]);
    expect(evaluateMerge(failed, relaxed).canMerge).toBe(true);
  });

  it("never requires CI confirmation when there is no CI at all", () => {
    const result = evaluateMerge(baseStatus({ pr: openPr() }), safeSettings);
    expect(result.confirmations).toEqual([]);
  });

  it("blocks conflicting merges and drafts", () => {
    const conflicting = baseStatus({ pr: openPr({ mergeable: "CONFLICTING" }) });
    expect(evaluateMerge(conflicting, safeSettings).blockers).toEqual(["Pull request has merge conflicts"]);

    const draft = baseStatus({ pr: openPr({ isDraft: true }) });
    expect(evaluateMerge(draft, safeSettings).blockers).toEqual(["Pull request is a draft"]);
  });

  it("requires confirmation when GitHub reports BLOCKED or UNSTABLE merge state", () => {
    const blocked = baseStatus({ pr: openPr({ mergeStateStatus: "BLOCKED" }) });
    expect(evaluateMerge(blocked, safeSettings).confirmations).toEqual(["GitHub reports merge state: BLOCKED"]);

    const unstable = baseStatus({ pr: openPr({ mergeStateStatus: "UNSTABLE" }) });
    expect(evaluateMerge(unstable, safeSettings).confirmations).toEqual(["GitHub reports merge state: UNSTABLE"]);
  });

  it("blocks on cold or not-git status", () => {
    expect(evaluateMerge(undefined, safeSettings).blockers).toEqual(["PR status is not available yet — refresh"]);
    expect(evaluateMerge(baseStatus({ git: false }), safeSettings).blockers).toEqual(["Not a git repository workspace"]);
    expect(evaluateMerge(baseStatus({ branch: "main", pr: undefined }), safeSettings).blockers).toEqual(["No open pull request for branch main"]);
  });

  it("blocks detached HEAD", () => {
    expect(evaluateMerge(baseStatus({ branch: "HEAD", pr: undefined }), safeSettings).blockers).toEqual(["HEAD is detached"]);
  });
});

describe("evaluateClose", () => {
  it("allows closing an open PR", () => {
    const result = evaluateClose(baseStatus({ pr: openPr() }), safeSettings);
    expect(result.canClose).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("blocks closing merged PRs or missing PRs", () => {
    expect(evaluateClose(baseStatus({ pr: openPr({ state: "MERGED" }) }), safeSettings).canClose).toBe(false);
    expect(evaluateClose(baseStatus(), safeSettings).canClose).toBe(false);
  });
});

describe("command builders", () => {
  it("builds merge commands for every method, never interactive", () => {
    for (const method of ["merge", "squash", "rebase"] as const) {
      const command = buildMergeCommand(7, { ...safeSettings, merge: { ...safeSettings.merge, method } });
      expect(command).toBe(`gh pr merge 7 --${method} < /dev/null`);
    }
    const deleteBranch: Settings = { ...safeSettings, merge: { ...safeSettings.merge, deleteBranch: true } };
    expect(buildMergeCommand(7, deleteBranch)).toBe("gh pr merge 7 --merge --delete-branch < /dev/null");
  });

  it("rejects non-integer or out-of-range PR numbers", () => {
    expect(() => buildMergeCommand(Number.NaN, safeSettings)).toThrow();
    expect(() => buildMergeCommand(1.5, safeSettings)).toThrow();
    expect(() => buildMergeCommand(-1, safeSettings)).toThrow();
    expect(() => buildCloseCommand(Number.NaN)).toThrow();
  });

  it("builds close commands", () => {
    expect(buildCloseCommand(42)).toBe("gh pr close 42 < /dev/null");
  });
});

describe("explainCiState", () => {
  it("explains each CI state for tooltips", () => {
    expect(explainCiState({ state: "none", total: 0, passed: 0, running: 0, failed: 0, checks: [] })).toBe("No CI checks");
    expect(explainCiState({ state: "passed", total: 3, passed: 3, running: 0, failed: 0, checks: [] })).toBe("CI passing (3/3)");
    expect(explainCiState({ state: "running", total: 3, passed: 1, running: 2, failed: 0, checks: [] })).toBe("CI running (1/3)");
    expect(explainCiState({ state: "failed", total: 3, passed: 1, running: 0, failed: 2, checks: [] })).toBe("CI failing (2 failed)");
  });
});
