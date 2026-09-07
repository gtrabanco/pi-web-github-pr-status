import type { CiSummary, PrStatus } from "./types.ts";
import type { Settings } from "./settings.ts";

export interface MergeEvaluation {
  /** True when no hard blocker stands; confirmations may still apply. */
  canMerge: boolean;
  /** Hard blockers — merging is refused. */
  blockers: string[];
  /** Soft reasons that require explicit confirmation (CI running/failed, …). */
  confirmations: string[];
}

export interface CloseEvaluation {
  canClose: boolean;
  blockers: string[];
}

const STATUS_UNAVAILABLE = "PR status is not available yet — refresh";

function dirtyCount(status: PrStatus): number {
  return status.staged + status.unstaged + status.untracked;
}

/** Collect the hard blockers and confirmation reasons for merging. */
export function evaluateMerge(status: PrStatus | undefined, settings: Settings): MergeEvaluation {
  if (!settings.merge.enabled) {
    return { canMerge: false, blockers: ["One-click merge is disabled in this workspace's plugin settings"], confirmations: [] };
  }
  if (status === undefined) {
    return { canMerge: false, blockers: [STATUS_UNAVAILABLE], confirmations: [] };
  }
  if (!status.git) {
    return { canMerge: false, blockers: ["Not a git repository workspace"], confirmations: [] };
  }

  const blockers: string[] = [];
  const pr = status.pr;
  if (pr === undefined) {
    blockers.push(status.branch === "HEAD" ? "HEAD is detached" : `No open pull request for branch ${status.branch ?? ""}`.trimEnd());
    return { canMerge: false, blockers, confirmations: [] };
  }
  if (pr.state === "MERGED") {
    blockers.push(`Pull request #${String(pr.number)} is already merged`);
  } else if (pr.state === "CLOSED") {
    blockers.push(`Pull request #${String(pr.number)} is closed`);
  }
  if (pr.isDraft) blockers.push("Pull request is a draft");
  if (pr.mergeable === "CONFLICTING") blockers.push("Pull request has merge conflicts");

  const dirty = dirtyCount(status);
  if (settings.merge.requireCleanWorktree && dirty > 0) {
    blockers.push(
      `Worktree has uncommitted changes (${String(status.staged)} staged, ${String(status.unstaged)} unstaged, ${String(status.untracked)} untracked)`,
    );
  }
  if (!status.hasUpstream) {
    blockers.push("Branch has no upstream — publish it first (git push -u)");
  } else if (status.ahead > 0) {
    blockers.push(`${String(status.ahead)} local commit(s) not pushed`);
  }

  const confirmations: string[] = [];
  if (settings.merge.requireCI) {
    const ciNote = ciConfirmation(status.ci);
    if (ciNote !== undefined) confirmations.push(ciNote);
  }
  if (status.behind > 0) {
    confirmations.push(`Local branch is ${String(status.behind)} commit(s) behind its upstream`);
  }
  if (pr.mergeStateStatus === "BLOCKED" || pr.mergeStateStatus === "UNSTABLE") {
    confirmations.push(`GitHub reports merge state: ${pr.mergeStateStatus}`);
  }
  return { canMerge: blockers.length === 0, blockers, confirmations };
}

function ciConfirmation(ci: CiSummary): string | undefined {
  if (ci.state === "running") return `CI is still running (${String(ci.passed)} passed, ${String(ci.running)} running)`;
  if (ci.state === "failed") return `CI has failures (${String(ci.failed)} failed)`;
  return undefined;
}

/** Closing is allowed for any known open PR. */
export function evaluateClose(status: PrStatus | undefined, _settings?: Settings): CloseEvaluation {
  if (status === undefined) return { canClose: false, blockers: [STATUS_UNAVAILABLE] };
  if (!status.git) return { canClose: false, blockers: ["Not a git repository workspace"] };
  const pr = status.pr;
  if (pr === undefined) {
    const reason = status.branch === "HEAD" ? "HEAD is detached" : `No open pull request for branch ${status.branch ?? ""}`.trimEnd();
    return { canClose: false, blockers: [reason] };
  }
  if (pr.state !== "OPEN") return { canClose: false, blockers: [`Pull request #${String(pr.number)} is ${pr.state.toLowerCase()}`] };
  return { canClose: true, blockers: [] };
}

function assertPrNumber(prNumber: number): void {
  if (!Number.isInteger(prNumber) || prNumber < 1 || prNumber > 2_147_483_647) {
    throw new Error(`Invalid pull request number: ${String(prNumber)}`);
  }
}

/**
 * Non-interactive `gh pr merge` invocation. stdin is redirected from
 * /dev/null so gh never prompts inside the workspace terminal.
 */
export function buildMergeCommand(prNumber: number, settings: Settings): string {
  assertPrNumber(prNumber);
  const flag = `--${settings.merge.method}`;
  const deleteFlag = settings.merge.deleteBranch ? " --delete-branch" : "";
  return `gh pr merge ${String(prNumber)} ${flag}${deleteFlag} < /dev/null`;
}

/** Non-interactive `gh pr close` invocation. */
export function buildCloseCommand(prNumber: number): string {
  assertPrNumber(prNumber);
  return `gh pr close ${String(prNumber)} < /dev/null`;
}

/** Human description of a CI summary, used for tooltips and messages. */
export function explainCiState(ci: CiSummary): string {
  switch (ci.state) {
    case "none":
      return "No CI checks";
    case "passed":
      return `CI passing (${String(ci.passed)}/${String(ci.total)})`;
    case "running":
      return `CI running (${String(ci.passed)}/${String(ci.total)})`;
    case "failed":
      return `CI failing (${String(ci.failed)} failed)`;
  }
}
