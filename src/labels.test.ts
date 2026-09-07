import { describe, expect, it } from "bun:test";
import { labelDescriptors } from "./labels.ts";
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
    ...overrides,
  };
}

describe("labelDescriptors", () => {
  it("returns nothing for cold, not-git or PR-less workspaces", () => {
    expect(labelDescriptors(undefined, true)).toEqual([]);
    expect(labelDescriptors(baseStatus({ git: false }), true)).toEqual([]);
    expect(labelDescriptors(baseStatus({ branch: "main" }), true)).toEqual([]);
  });

  it("shows an open PR as a link first", () => {
    const items = labelDescriptors(baseStatus({ pr: openPr() }), true);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      kind: "prLink",
      number: 7,
      href: "https://github.com/acme/app/pull/7",
      title: "PR #7: Add PR monitor",
      draft: false,
    });
  });

  it("marks draft PRs in the title", () => {
    const items = labelDescriptors(baseStatus({ pr: openPr({ isDraft: true }) }), true);
    expect(items[0]).toMatchObject({ draft: true, title: "PR #7 (draft): Add PR monitor" });
  });

  it("hides labels for merged or closed PRs", () => {
    expect(labelDescriptors(baseStatus({ pr: openPr({ state: "MERGED" }) }), true)).toEqual([]);
    expect(labelDescriptors(baseStatus({ pr: openPr({ state: "CLOSED" }) }), true)).toEqual([]);
  });

  it("adds a CI dot only for existing CI and when showCI is enabled", () => {
    const withCi = baseStatus({ pr: openPr(), ci: { state: "passed", total: 2, passed: 2, running: 0, failed: 0, checks: [] } });
    expect(labelDescriptors(withCi, true)[1]).toEqual({
      kind: "ciDot",
      ciState: "passed",
      href: "https://github.com/acme/app/pull/7",
      title: "CI passing (2/2)",
    });
    expect(labelDescriptors(withCi, false).map((item) => item.kind)).toEqual(["prLink"]);
    const noCi = baseStatus({ pr: openPr() });
    expect(labelDescriptors(noCi, true).map((item) => item.kind)).toEqual(["prLink"]);
  });

  it("adds a dirty dot with a descriptive title when the worktree is dirty", () => {
    const dirty = baseStatus({ pr: openPr(), staged: 1, unstaged: 2, untracked: 3 });
    expect(labelDescriptors(dirty, true)[1]).toEqual({
      kind: "dirtyDot",
      count: 6,
      title: "Uncommitted changes: 1 staged, 2 unstaged, 3 untracked",
    });
    const clean = baseStatus({ pr: openPr() });
    expect(labelDescriptors(clean, true).map((item) => item.kind)).toEqual(["prLink"]);
  });

  it("adds push and pull arrows", () => {
    const status = baseStatus({ pr: openPr(), ahead: 2, behind: 1 });
    const kinds = labelDescriptors(status, true).map((item) => item.kind);
    expect(kinds).toEqual(["prLink", "aheadArrow", "behindArrow"]);
    expect(labelDescriptors(status, true)[1]).toMatchObject({ count: 2, title: "2 commit(s) not pushed" });
    expect(labelDescriptors(status, true)[2]).toMatchObject({ count: 1, title: "1 commit(s) behind upstream" });
  });

  it("orders items: pr, ci, dirty, ahead, behind", () => {
    const status = baseStatus({
      pr: openPr(),
      ci: { state: "running", total: 3, passed: 1, running: 2, failed: 0, checks: [] },
      staged: 1,
      ahead: 1,
      behind: 1,
    });
    expect(labelDescriptors(status, true).map((item) => item.kind)).toEqual(["prLink", "ciDot", "dirtyDot", "aheadArrow", "behindArrow"]);
  });
});
