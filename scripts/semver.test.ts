import { describe, expect, it } from "bun:test";
import { bumpVersion, computeNextVersion, normalizeNextRelease, parseVersion, RELEASE_KINDS } from "./semver.ts";

describe("parseVersion", () => {
  it("parses strict X.Y.Z versions", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("0.1.0")).toEqual({ major: 0, minor: 1, patch: 0 });
  });

  it("rejects non-strict versions", () => {
    for (const bad of ["1.2", "v1.2.3", "1.2.3-beta.1", "01.2.3", "1.2.3.4", "", "1.2.x"]) {
      expect(() => parseVersion(bad), bad).toThrow();
    }
  });
});

describe("computeNextVersion", () => {
  it("bumps patch by default kind", () => {
    expect(computeNextVersion("0.1.0", "patch")).toBe("0.1.1");
    expect(computeNextVersion("1.2.3", "patch")).toBe("1.2.4");
  });

  it("bumps minor and resets patch", () => {
    expect(computeNextVersion("0.1.0", "minor")).toBe("0.2.0");
    expect(computeNextVersion("1.2.3", "minor")).toBe("1.3.0");
  });

  it("bumps major and resets minor and patch", () => {
    expect(computeNextVersion("0.1.0", "major")).toBe("1.0.0");
    expect(computeNextVersion("1.2.3", "major")).toBe("2.0.0");
    expect(computeNextVersion("9.9.9", "major")).toBe("10.0.0");
  });
});

describe("normalizeNextRelease", () => {
  it("accepts the three kinds", () => {
    for (const kind of RELEASE_KINDS) {
      expect(normalizeNextRelease(kind)).toBe(kind);
    }
  });

  it("rejects everything else", () => {
    for (const bad of [undefined, "", "beta", "MINOR", "hotfix", 42]) {
      expect(() => normalizeNextRelease(bad), String(bad)).toThrow(/nextRelease/);
    }
  });
});

describe("bumpVersion", () => {
  it("returns the version object and string for a given kind", () => {
    expect(bumpVersion({ major: 0, minor: 1, patch: 0 }, "minor")).toEqual({ major: 0, minor: 2, patch: 0 });
  });
});
