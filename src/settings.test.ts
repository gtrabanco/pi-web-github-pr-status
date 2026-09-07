import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS, normalizeSettings, serializeSettings, type Settings } from "./settings.ts";

describe("normalizeSettings", () => {
  it("returns defaults for missing, null or non-object config", () => {
    for (const raw of [undefined, null, 42, "x", []]) {
      const { settings, warnings } = normalizeSettings(raw);
      expect(settings).toEqual(DEFAULT_SETTINGS);
      expect(warnings).toEqual([]);
    }
  });

  it("returns defaults for an empty object", () => {
    const { settings, warnings } = normalizeSettings({});
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(warnings).toEqual([]);
  });

  it("keeps valid values and fills the rest", () => {
    const { settings, warnings } = normalizeSettings({
      showCI: false,
      refreshSeconds: 30,
      merge: { enabled: false, method: "squash", requireCleanWorktree: false, requireCI: false, deleteBranch: true },
    });
    expect(settings).toEqual({
      showCI: false,
      refreshSeconds: 30,
      merge: { enabled: false, method: "squash", requireCleanWorktree: false, requireCI: false, deleteBranch: true },
    });
    expect(warnings).toEqual([]);
  });

  it("accepts partial merge objects and partial top-level objects", () => {
    const { settings } = normalizeSettings({ merge: { method: "rebase" } });
    expect(settings.merge).toEqual({ ...DEFAULT_SETTINGS.merge, method: "rebase" });
    expect(settings.showCI).toBe(DEFAULT_SETTINGS.showCI);
  });

  it("coerces boolean-ish values and rejects the rest", () => {
    const { settings, warnings } = normalizeSettings({ showCI: 1, merge: { enabled: "true", requireCI: "nope" } });
    expect(settings.showCI).toBe(true);
    expect(settings.merge.enabled).toBe(true);
    expect(settings.merge.requireCI).toBe(DEFAULT_SETTINGS.merge.requireCI);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects unknown merge methods with a warning and keeps the default", () => {
    const { settings, warnings } = normalizeSettings({ merge: { method: "fast-forward" } });
    expect(settings.merge.method).toBe(DEFAULT_SETTINGS.merge.method);
    expect(warnings).toEqual(["merge.method: ignored invalid value \"fast-forward\""]);
  });

  it("clamps refreshSeconds into [0, 3600] and defaults non-numbers to 0", () => {
    expect(normalizeSettings({ refreshSeconds: -5 }).settings.refreshSeconds).toBe(0);
    expect(normalizeSettings({ refreshSeconds: 99999 }).settings.refreshSeconds).toBe(3600);
    expect(normalizeSettings({ refreshSeconds: "x" }).settings.refreshSeconds).toBe(DEFAULT_SETTINGS.refreshSeconds);
    expect(normalizeSettings({ refreshSeconds: 45.7 }).settings.refreshSeconds).toBe(45);
  });

  it("never throws on hostile input", () => {
    const hostile = { showCI: { a: [] }, merge: { method: 5, requireCI: [] }, refreshSeconds: { x: 1 } };
    expect(() => normalizeSettings(hostile)).not.toThrow();
  });
});

describe("serializeSettings", () => {
  it("round-trips settings through normalizeSettings", () => {
    const custom: Settings = {
      showCI: false,
      refreshSeconds: 60,
      merge: { enabled: true, method: "squash", requireCleanWorktree: false, requireCI: true, deleteBranch: true },
    };
    const { settings, warnings } = normalizeSettings(JSON.parse(serializeSettings(custom)));
    expect(settings).toEqual(custom);
    expect(warnings).toEqual([]);
  });

  it("ends with a newline and is pretty-printed", () => {
    const text = serializeSettings(DEFAULT_SETTINGS);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain("\n  ");
  });
});
