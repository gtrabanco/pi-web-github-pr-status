import { describe, expect, it } from "bun:test";
import {
  INTERVAL_PATH,
  STOP_PATH,
  TRIGGER_PATH,
  WATCHER_MAX_LIFETIME_S,
  WATCHER_STATE_PATH,
  WATCH_COMMAND,
  WATCH_ONCE_COMMAND,
  WATCH_SCRIPT,
  WATCH_SCRIPT_PATH,
  isWatcherAlive,
  parseWatcherState,
  serializeInterval,
} from "./watch.ts";

/**
 * The watch script is the plugin's answer to pi-web keeping every command-run
 * terminal forever (jmfederico/pi-web#225): instead of one terminal per probe,
 * a single long-lived watcher terminal writes the scratch files on a loop. The
 * script must therefore be static, self-terminating and side-effect bounded.
 */

const FACT_FILES = ["branch.txt", "head.txt", "upstream.txt", "staged.txt", "unstaged.txt", "untracked.txt", "ab.txt", "pr.json", "gh.err"];

describe("watch script artifacts", () => {
  it("uses static commands without interpolated user input", () => {
    expect(WATCH_COMMAND).toBe("sh .pi-web/github-pr/watch.sh");
    expect(WATCH_ONCE_COMMAND).toBe("sh .pi-web/github-pr/watch.sh once");
    expect(WATCH_COMMAND.includes("'")).toBe(false);
    expect(WATCH_SCRIPT_PATH).toBe(".pi-web/github-pr/watch.sh");
  });

  it("is POSIX sh and exits 0 in both modes", () => {
    expect(WATCH_SCRIPT.startsWith("#!/bin/sh")).toBe(true);
    expect(WATCH_SCRIPT).toContain("exit 0");
  });

  it("runs one fact-collection cycle when invoked with `once`", () => {
    expect(WATCH_SCRIPT).toContain('"once"');
  });

  it("writes the probe marker after every other scratch file", () => {
    const markerIndex = WATCH_SCRIPT.indexOf("probe.json");
    expect(markerIndex).toBeGreaterThan(0);
    for (const name of FACT_FILES) {
      const firstUse = WATCH_SCRIPT.indexOf(name);
      expect(firstUse, name).toBeGreaterThanOrEqual(0);
      if (name !== "gh.err") expect(firstUse, `${name} before marker`).toBeLessThan(markerIndex);
    }
  });

  it("excludes its own scratch dir from untracked counts", () => {
    expect(WATCH_SCRIPT).toContain("git ls-files --others");
    expect(WATCH_SCRIPT).toContain("--exclude=.pi-web/github-pr/");
  });

  it("computes ahead/behind against the upstream", () => {
    expect(WATCH_SCRIPT).toContain('git rev-list --left-right --count "@{u}"..."HEAD"');
  });

  it("bounds each gh call with timeout when available", () => {
    expect(WATCH_SCRIPT).toContain("command -v timeout");
    expect(WATCH_SCRIPT).toContain("timeout 20");
  });

  it("sleeps in short slices so trigger and stop are honored quickly", () => {
    expect(WATCH_SCRIPT).toContain("sleep");
    expect(WATCH_SCRIPT).toContain("-f \"$T\"");
    expect(WATCH_SCRIPT).toContain("-f \"$P\"");
  });

  it("removes its state file on every exit path", () => {
    // stop file exit, lifetime exit, disabled-interval exit
    expect(WATCH_SCRIPT.match(/rm -f "\$S"/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("caps its own lifetime at 12 hours", () => {
    expect(WATCHER_MAX_LIFETIME_S).toBe(43_200);
    expect(WATCH_SCRIPT).toContain("43200");
  });

  it("reads the interval from the browser-owned interval file with a safe fallback", () => {
    expect(WATCH_SCRIPT).toContain(`"$I"`);
    expect(WATCH_SCRIPT).toContain("*[!0-9]*");
  });

  it("treats a non-positive interval as disabled and exits", () => {
    expect(WATCH_SCRIPT).toContain("-le 0");
  });

  it("updates watcher.json with pid, timestamp and interval each cycle", () => {
    expect(WATCH_SCRIPT).toContain(WATCHER_STATE_PATH);
    expect(WATCH_SCRIPT).toContain('"pid"');
    expect(WATCH_SCRIPT).toContain('"interval"');
  });

  it("does not reference probe.sh", () => {
    expect(WATCH_SCRIPT.includes("probe.sh")).toBe(false);
  });
});

describe("watcher state", () => {
  it("parses a watcher.json record", () => {
    expect(parseWatcherState('{"v":1,"pid":123,"ts":1700000000,"interval":90}')).toEqual({
      pid: 123,
      ts: 1_700_000_000,
      interval: 90,
    });
  });

  it("returns an empty state for missing or garbage files", () => {
    expect(parseWatcherState(undefined)).toEqual({});
    expect(parseWatcherState("")).toEqual({});
    expect(parseWatcherState("not json{")).toEqual({});
    expect(parseWatcherState("42")).toEqual({});
    expect(parseWatcherState('{"ts":"x"}')).toEqual({});
  });

  it("considers a watcher alive inside the freshness window", () => {
    const settingsIntervalSec = 90;
    const ts = 1_000_000;
    const state = { pid: 1, ts, interval: 90 };
    expect(isWatcherAlive(state, settingsIntervalSec, ts + 60)).toBe(true);
    expect(isWatcherAlive(state, settingsIntervalSec, ts + 200_000)).toBe(false);
  });

  it("keeps a slow watcher alive across long cycles", () => {
    const ts = 1_000_000;
    const state = { pid: 1, ts, interval: 900 };
    // 2 * 900s + slack = 1830s window
    expect(isWatcherAlive(state, 90, ts + 1_800)).toBe(true);
    expect(isWatcherAlive(state, 90, ts + 1_900)).toBe(false);
  });

  it("never trusts a state without a timestamp", () => {
    expect(isWatcherAlive({}, 90, 1_000_000)).toBe(false);
  });
});

describe("interval file", () => {
  it("serializes seconds with a trailing newline", () => {
    expect(serializeInterval(90)).toBe("90\n");
    expect(serializeInterval(0)).toBe("0\n");
  });

  it("exposes stable scratch paths inside the plugin dir", () => {
    expect(INTERVAL_PATH).toBe(".pi-web/github-pr/interval.txt");
    expect(TRIGGER_PATH).toBe(".pi-web/github-pr/trigger");
    expect(STOP_PATH).toBe(".pi-web/github-pr/stop");
    expect(WATCHER_STATE_PATH).toBe(".pi-web/github-pr/watcher.json");
  });
});
