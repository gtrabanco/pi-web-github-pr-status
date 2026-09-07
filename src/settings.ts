/** Workspace plugin settings stored in `.pi-web/github-pr.json`. */

export interface MergeSettings {
  /** Master switch for one-click merge from the panel. */
  enabled: boolean;
  /** GitHub merge method used by `gh pr merge`. */
  method: "merge" | "squash" | "rebase";
  /** Block merging while the worktree has uncommitted changes. */
  requireCleanWorktree: boolean;
  /** Require confirmation when CI is running or failed (only when CI exists). */
  requireCI: boolean;
  /** Pass --delete-branch to gh pr merge. */
  deleteBranch: boolean;
}

export interface Settings {
  /** Show the CI ball in labels and the CI section in the panel. */
  showCI: boolean;
  /** Background probe interval in seconds; 0 disables automatic probing. */
  refreshSeconds: number;
  merge: MergeSettings;
}

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  showCI: true,
  refreshSeconds: 90,
  merge: Object.freeze({
    enabled: true,
    method: "merge",
    requireCleanWorktree: true,
    requireCI: true,
    deleteBranch: false,
  }),
});

export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export const MIN_REFRESH_SECONDS = 0;
export const MAX_REFRESH_SECONDS = 3600;

type Warning = string;

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Coerce common boolean spellings; returns undefined when unrecognized. */
function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === 1) return true;
  if (value === 0) return false;
  return undefined;
}

function mergeBooleans(
  raw: Record<string, unknown>,
  defaults: MergeSettings,
  warnings: Warning[],
  prefix: string,
): MergeSettings {
  const pick = (key: Exclude<keyof MergeSettings, "method">): boolean => {
    const coerced = coerceBoolean(raw[key]);
    if (coerced === undefined) {
      if (raw[key] !== undefined) warnings.push(`${prefix}${key}: ignored invalid value`);
      return defaults[key];
    }
    return coerced;
  };
  return {
    enabled: pick("enabled"),
    requireCleanWorktree: pick("requireCleanWorktree"),
    requireCI: pick("requireCI"),
    deleteBranch: pick("deleteBranch"),
    method: normalizeMethod(raw.method, defaults.method, warnings),
  };
}

function normalizeMethod(value: unknown, fallback: MergeMethod, warnings: Warning[]): MergeMethod {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (MERGE_METHODS as readonly string[]).includes(value)) {
    return value as MergeMethod;
  }
  warnings.push(`merge.method: ignored invalid value ${JSON.stringify(String(value))}`);
  return fallback;
}

function normalizeRefreshSeconds(value: unknown, fallback: number, warnings: Warning[]): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push("refreshSeconds: ignored invalid value");
    return fallback;
  }
  const seconds = Math.max(MIN_REFRESH_SECONDS, Math.min(MAX_REFRESH_SECONDS, Math.floor(value)));
  return seconds;
}

/**
 * Normalize unknown config data into full settings. Never throws; invalid
 * values fall back to defaults and are reported through `warnings`.
 */
export function normalizeSettings(raw: unknown): { settings: Settings; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const source = asObject(raw);
  const showCI = coerceBoolean(source.showCI);
  if (showCI === undefined && source.showCI !== undefined) warnings.push("showCI: ignored invalid value");

  const mergeSource = asObject(source.merge);
  const settings: Settings = {
    showCI: showCI ?? DEFAULT_SETTINGS.showCI,
    refreshSeconds: normalizeRefreshSeconds(source.refreshSeconds, DEFAULT_SETTINGS.refreshSeconds, warnings),
    merge: mergeBooleans(mergeSource, DEFAULT_SETTINGS.merge, warnings, "merge."),
  };
  return { settings, warnings };
}

export function serializeSettings(settings: Settings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}
