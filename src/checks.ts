import type { CiCheck, CiCheckState, CiState, CiSummary } from "./types.ts";

/** CI summary used when there is nothing to report (no CI, broken data, …). */
export const EMPTY_CI: CiSummary = Object.freeze({ state: "none", total: 0, passed: 0, running: 0, failed: 0, checks: [] });

const FAILING_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED", "STARTUP_FAILURE"]);
const NEUTRAL_CONCLUSIONS = new Set(["NEUTRAL", "SKIPPED"]);

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function parseCheckRun(entry: Record<string, unknown>): CiCheck | undefined {
  const name = optionalString(entry.name) ?? "check";
  const status = optionalString(entry.status);
  const conclusion = optionalString(entry.conclusion);
  let state: CiCheckState;
  if (status !== "COMPLETED" || conclusion === undefined) {
    state = "running";
  } else if (conclusion === "SUCCESS") {
    state = "passed";
  } else if (NEUTRAL_CONCLUSIONS.has(conclusion)) {
    state = "skipped";
  } else if (FAILING_CONCLUSIONS.has(conclusion)) {
    state = "failed";
  } else {
    state = "running";
  }
  return { name, state, url: optionalString(entry.detailsUrl), workflow: optionalString(entry.workflowName) };
}

function parseStatusContext(entry: Record<string, unknown>): CiCheck | undefined {
  const name = optionalString(entry.context) ?? "status";
  const state = optionalString(entry.state);
  let checkState: CiCheckState;
  if (state === "SUCCESS") {
    checkState = "passed";
  } else if (state === "PENDING" || state === "EXPECTED") {
    checkState = "running";
  } else if (state === "FAILURE" || state === "ERROR") {
    checkState = "failed";
  } else {
    return undefined;
  }
  return { name, state: checkState, url: optionalString(entry.targetUrl) };
}

/**
 * Summarize a `gh pr view --json statusCheckRollup` array.
 *
 * Ball semantics: any failing check → failed (red), otherwise any running or
 * queued check → running (orange), otherwise at least one known check →
 * passed (green), otherwise none (no ball).
 */
export function summarizeChecks(rollup: unknown): CiSummary {
  if (!Array.isArray(rollup)) return EMPTY_CI;
  const checks: CiCheck[] = [];
  for (const raw of rollup) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const typename = optionalString(entry.__typename);
    if (typename === "CheckRun") {
      const check = parseCheckRun(entry);
      if (check !== undefined) checks.push(check);
    } else if (typename === "StatusContext") {
      const check = parseStatusContext(entry);
      if (check !== undefined) checks.push(check);
    }
  }
  if (checks.length === 0) return EMPTY_CI;

  let passed = 0;
  let running = 0;
  let failed = 0;
  for (const check of checks) {
    if (check.state === "failed") failed += 1;
    else if (check.state === "running") running += 1;
    else passed += 1;
  }
  const state: CiState = failed > 0 ? "failed" : running > 0 ? "running" : "passed";
  return { state, total: checks.length, passed, running, failed, checks };
}
