import { describe, expect, it } from "bun:test";
import { summarizeChecks, EMPTY_CI } from "./checks.ts";

function checkRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: "CheckRun",
    name: "build",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    detailsUrl: "https://github.com/acme/app/actions/runs/1",
    workflowName: "CI",
    ...overrides,
  };
}

function statusContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: "StatusContext",
    context: "ci/travis",
    state: "SUCCESS",
    targetUrl: "https://travis.example/build/1",
    ...overrides,
  };
}

describe("summarizeChecks", () => {
  it("returns none for empty rollup (no CI configured)", () => {
    expect(summarizeChecks([])).toEqual(EMPTY_CI);
    expect(summarizeChecks(undefined)).toEqual(EMPTY_CI);
    expect(summarizeChecks(null)).toEqual(EMPTY_CI);
    expect(summarizeChecks("garbage")).toEqual(EMPTY_CI);
    expect(summarizeChecks([{ unexpected: true }])).toEqual(EMPTY_CI);
  });

  it("returns passed when all checks are successful", () => {
    const summary = summarizeChecks([checkRun(), statusContext()]);
    expect(summary.state).toBe("passed");
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(2);
    expect(summary.running).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.checks).toHaveLength(2);
    expect(summary.checks[0]).toMatchObject({ name: "build", state: "passed", url: "https://github.com/acme/app/actions/runs/1" });
  });

  it("returns failed when any check run failed", () => {
    for (const conclusion of ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED", "STARTUP_FAILURE"]) {
      const summary = summarizeChecks([checkRun(), checkRun({ name: "bad", conclusion })]);
      expect(summary.state, `conclusion ${conclusion}`).toBe("failed");
      expect(summary.failed).toBe(1);
      expect(summary.checks[1]?.state).toBe("failed");
    }
  });

  it("returns failed when a status context reports ERROR or FAILURE", () => {
    for (const state of ["FAILURE", "ERROR"]) {
      const summary = summarizeChecks([statusContext({ state })]);
      expect(summary.state, `state ${state}`).toBe("failed");
    }
  });

  it("returns running while any check is queued or in progress", () => {
    for (const status of ["IN_PROGRESS", "QUEUED", "PENDING"]) {
      const summary = summarizeChecks([checkRun(), checkRun({ name: "slow", status, conclusion: null })]);
      expect(summary.state, `status ${status}`).toBe("running");
      expect(summary.running).toBe(1);
      expect(summary.checks[1]?.state).toBe("running");
    }
  });

  it("returns running while a status context is pending", () => {
    for (const state of ["PENDING", "EXPECTED"]) {
      const summary = summarizeChecks([statusContext({ state })]);
      expect(summary.state, `state ${state}`).toBe("running");
    }
  });

  it("failure wins over running (worst state reported)", () => {
    const summary = summarizeChecks([
      checkRun({ name: "slow", status: "IN_PROGRESS", conclusion: null }),
      checkRun({ name: "bad", conclusion: "FAILURE" }),
    ]);
    expect(summary.state).toBe("failed");
  });

  it("counts neutral and skipped checks as passed", () => {
    const summary = summarizeChecks([
      checkRun({ name: "lint", conclusion: "NEUTRAL" }),
      checkRun({ name: "windows", conclusion: "SKIPPED" }),
      checkRun({ name: "build", conclusion: "SUCCESS" }),
    ]);
    expect(summary.state).toBe("passed");
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(3);
  });

  it("ignores unknown entries but keeps known ones", () => {
    const summary = summarizeChecks([checkRun(), { __typename: "SomethingElse", name: "x" }]);
    expect(summary.total).toBe(1);
    expect(summary.state).toBe("passed");
  });

  it("maps targetUrl for status contexts", () => {
    const summary = summarizeChecks([statusContext()]);
    expect(summary.checks[0]?.url).toBe("https://travis.example/build/1");
  });
});
