/** Minimal strict-semver helpers for the release script (no dependencies). */

export const RELEASE_KINDS = ["major", "minor", "patch"] as const;
export type ReleaseKind = (typeof RELEASE_KINDS)[number];

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

/** Parse a strict `X.Y.Z` version; anything else throws. */
export function parseVersion(version: string): Version {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (match === null) throw new Error(`Invalid strict semver version: ${JSON.stringify(version)} (expected X.Y.Z)`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function formatVersion(version: Version): string {
  return `${String(version.major)}.${String(version.minor)}.${String(version.patch)}`;
}

export function bumpVersion(version: Version, kind: ReleaseKind): Version {
  switch (kind) {
    case "major":
      return { major: version.major + 1, minor: 0, patch: 0 };
    case "minor":
      return { major: version.major, minor: version.minor + 1, patch: 0 };
    case "patch":
      return { major: version.major, minor: version.minor, patch: version.patch + 1 };
  }
}

/** Validate the registered next-release marker. */
export function normalizeNextRelease(value: unknown): ReleaseKind {
  if (typeof value === "string" && (RELEASE_KINDS as readonly string[]).includes(value)) {
    return value as ReleaseKind;
  }
  throw new Error(
    `Invalid package.json nextRelease: ${JSON.stringify(value === undefined ? null : value)}. Register the next release kind with: bun run release:patch|release:minor|release:major`,
  );
}

/** Compute the next version string for a current version and release kind. */
export function computeNextVersion(current: string, kind: ReleaseKind): string {
  return formatVersion(bumpVersion(parseVersion(current), kind));
}
