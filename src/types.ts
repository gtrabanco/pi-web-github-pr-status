/** Shared domain types for the GitHub PR status plugin. */

export const PLUGIN_ID = "github-pr-status";

/** Plugin-owned scratch/config locations inside a workspace. */
export const SETTINGS_PATH = ".pi-web/github-pr.json";
export const SCRATCH_DIR = ".pi-web/github-pr";
export const PROBE_SCRIPT_PATH = `${SCRATCH_DIR}/probe.sh`;
export const PROBE_MARKER_PATH = `${SCRATCH_DIR}/probe.json`;

export type CiState = "none" | "running" | "failed" | "passed";
export type CiCheckState = "passed" | "running" | "failed" | "skipped";

export interface CiCheck {
  name: string;
  state: CiCheckState;
  url?: string;
  workflow?: string;
}

export interface CiSummary {
  state: CiState;
  total: number;
  passed: number;
  running: number;
  failed: number;
  checks: CiCheck[];
}

/** How the `gh` CLI behaved during the last probe. */
export type GhStatus = "ok" | "missing" | "unauthenticated" | "error";

export interface PrInfo {
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  author?: string;
  baseRefName?: string;
  headRefName?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
}

/**
 * One probe result for a workspace. Everything is derived from files the
 * probe script wrote into the workspace, so this type must stay JSON-plain.
 */
export interface PrStatus {
  /** False when the probe found no git worktree (or never ran — cold). */
  git: boolean;
  /** Epoch seconds reported by the machine that ran the probe. */
  probeAt?: number;
  /** True when no probe marker exists yet. */
  cold?: boolean;
  branch?: string;
  head?: string;
  upstream?: string;
  staged: number;
  unstaged: number;
  untracked: number;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  pr?: PrInfo;
  ci: CiSummary;
  gh?: GhStatus;
  ghMessage?: string;
  isDirty?: boolean;
  unpushed?: boolean;
}
