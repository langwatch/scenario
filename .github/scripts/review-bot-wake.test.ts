import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classify,
  latestRunPerWorkflow,
  nextPageUrl,
  waitForChecks,
  type CheckRun,
  type CheckSuite,
  type Snapshot,
  type WorkflowRun,
} from "./review-bot-wake.ts";

const OWN = { excludeCheck: "review-bot-wake", ownRunId: 900 };

let nextId = 1;
const checkRun = (suite: number, name: string, overrides: Partial<CheckRun> = {}): CheckRun => ({
  id: nextId++,
  name,
  status: "completed",
  conclusion: "success",
  check_suite: { id: suite },
  ...overrides,
});

const suite = (id: number, overrides: Partial<CheckSuite> = {}): CheckSuite => ({
  id,
  status: "completed",
  latest_check_runs_count: 1,
  app: { slug: "github-actions" },
  ...overrides,
});

const workflowRun = (
  id: number,
  workflowId: number,
  name: string,
  suiteId: number,
  overrides: Partial<WorkflowRun> = {},
): WorkflowRun => ({
  id,
  workflow_id: workflowId,
  name,
  check_suite_id: suiteId,
  status: "completed",
  created_at: "2026-11-25T07:17:22Z",
  run_started_at: "2026-11-25T07:17:22Z",
  ...overrides,
});

const snapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  checkRuns: [],
  checkSuites: [],
  statuses: [],
  workflowRuns: [],
  ...overrides,
});

/** python-ci and javascript-ci both green, plus this job's own run. */
const greenCommit = (): Snapshot =>
  snapshot({
    workflowRuns: [
      workflowRun(1, 10, "python-ci", 101),
      workflowRun(2, 20, "javascript-ci", 201),
      workflowRun(900, 90, "review-bot-wake", 901, { status: "in_progress" }),
    ],
    checkSuites: [suite(101), suite(201), suite(901, { status: "in_progress" })],
    checkRuns: [
      checkRun(101, "test (3.12)"),
      checkRun(201, "test"),
      checkRun(901, "review-bot-wake", { status: "in_progress", conclusion: null }),
    ],
    statuses: [{ context: "ci/external", state: "success" }],
  });

describe("given every check on the head commit finished green", () => {
  /** @scenario "All checks green wakes the review bot with one comment" */
  it("is green", () => {
    assert.deepEqual(classify(greenCommit(), OWN), { kind: "green" });
  });
});

describe("given a check run that failed", () => {
  /** @scenario "A red check wakes nothing" */
  it("is red and names the workflow and job", () => {
    const data = greenCommit();
    data.checkRuns.push(checkRun(101, "lint", { conclusion: "failure" }));
    assert.deepEqual(classify(data, OWN), { kind: "red", failed: ["python-ci / lint"] });
  });

  it("is red even while other checks still run", () => {
    const data = greenCommit();
    data.checkRuns.push(checkRun(101, "lint", { conclusion: "timed_out" }));
    data.checkRuns.push(checkRun(201, "build", { status: "in_progress", conclusion: null }));
    assert.equal(classify(data, OWN).kind, "red");
  });

  it("counts a cancelled job of the newest run as red", () => {
    const data = greenCommit();
    data.checkRuns.push(checkRun(201, "build", { conclusion: "cancelled" }));
    assert.deepEqual(classify(data, OWN), { kind: "red", failed: ["javascript-ci / build"] });
  });
});

describe("given a commit status that failed", () => {
  /** @scenario "A red commit status wakes nothing" */
  it("is red for failure and for error", () => {
    for (const state of ["failure", "error"]) {
      const data = greenCommit();
      data.statuses.push({ context: "vercel", state });
      assert.deepEqual(classify(data, OWN), { kind: "red", failed: ["vercel"] });
    }
  });

  it("is pending while a status is pending", () => {
    const data = greenCommit();
    data.statuses.push({ context: "vercel", state: "pending" });
    assert.deepEqual(classify(data, OWN), { kind: "pending", pending: ["vercel"] });
  });
});

describe("given a workflow that ran twice on the head commit", () => {
  // The shape seen live on langwatch/scenario PR 1071 at b4e2d06: run 2812 was
  // re-run first and then cancelled by the re-run of run 2805, which started
  // three seconds later through the same concurrency group, and run 2810 was
  // cancelled by 2811 at the start.
  const superseded = (): Snapshot => {
    const data = greenCommit();
    data.workflowRuns.push(
      workflowRun(2812, 30, "auto-approve", 2812, {
        created_at: "2026-11-25T07:58:35Z",
        run_started_at: "2026-11-25T18:33:58Z",
      }),
      workflowRun(2811, 30, "auto-approve", 2811, {
        created_at: "2026-11-25T07:58:35Z",
        run_started_at: "2026-11-25T07:58:35Z",
      }),
      workflowRun(2810, 30, "auto-approve", 2810, {
        created_at: "2026-11-25T07:58:35Z",
        run_started_at: "2026-11-25T07:58:35Z",
      }),
      workflowRun(2805, 30, "auto-approve", 2805, {
        created_at: "2026-11-25T07:17:22Z",
        run_started_at: "2026-11-25T18:34:01Z",
      }),
    );
    data.checkSuites.push(suite(2812), suite(2811), suite(2810), suite(2805));
    data.checkRuns.push(
      checkRun(2812, "preflight", { conclusion: "cancelled" }),
      checkRun(2812, "evaluate", { conclusion: "cancelled" }),
      checkRun(2810, "preflight", { conclusion: "cancelled" }),
      checkRun(2811, "preflight"),
      checkRun(2805, "preflight"),
      checkRun(2805, "evaluate"),
    );
    return data;
  };

  /** @scenario "A run cancelled by a newer run of its workflow is ignored" */
  it("judges only the run whose latest attempt started last", () => {
    assert.deepEqual(classify(superseded(), OWN), { kind: "green" });
  });

  it("picks the newest attempt by its start, not by run number", () => {
    const latest = latestRunPerWorkflow(superseded().workflowRuns).find(
      (run) => run.workflow_id === 30,
    );
    assert.equal(latest?.id, 2805);
  });

  it("still judges the newest run when it is the red one", () => {
    const data = superseded();
    data.checkRuns.push(checkRun(2805, "evaluate", { conclusion: "failure" }));
    assert.deepEqual(classify(data, OWN), { kind: "red", failed: ["auto-approve / evaluate"] });
  });

  it("keeps waiting while the newest run is still running", () => {
    const data = superseded();
    data.workflowRuns.push(
      workflowRun(2813, 30, "auto-approve", 2813, {
        status: "queued",
        run_started_at: "2026-11-25T19:00:00Z",
      }),
    );
    assert.deepEqual(classify(data, OWN), { kind: "pending", pending: ["auto-approve"] });
  });
});

describe("given same-named jobs in different workflows", () => {
  /** @scenario "Same-named jobs in different workflows are judged apart" */
  it("judges each workflow's job on its own", () => {
    const data = greenCommit();
    data.checkRuns.push(checkRun(101, "test", { conclusion: "failure" }));
    assert.deepEqual(classify(data, OWN), { kind: "red", failed: ["python-ci / test"] });
  });

  it("lets a re-run of a job supersede its old run within the same suite", () => {
    const data = greenCommit();
    data.checkRuns.unshift(checkRun(201, "test", { conclusion: "failure", id: 0 }));
    assert.deepEqual(classify(data, OWN), { kind: "green" });
  });
});

describe("given a workflow still running", () => {
  /** @scenario "A suite still running is waited for" */
  it("is pending while a suite runs between jobs", () => {
    const data = greenCommit();
    data.checkSuites[0] = suite(101, { status: "in_progress" });
    data.workflowRuns[0] = workflowRun(1, 10, "python-ci", 101, { status: "in_progress" });
    assert.deepEqual(classify(data, OWN), { kind: "pending", pending: ["python-ci"] });
  });

  it("is pending while a job runs", () => {
    const data = greenCommit();
    data.checkRuns.push(checkRun(201, "build", { status: "queued", conclusion: null }));
    assert.deepEqual(classify(data, OWN), { kind: "pending", pending: ["javascript-ci / build"] });
  });

  it("leaves out suites of apps that never report a check run", () => {
    const data = greenCommit();
    data.checkSuites.push(suite(555, { status: "queued", latest_check_runs_count: 0 }));
    assert.deepEqual(classify(data, OWN), { kind: "green" });
  });
});

describe("given this job's own check run", () => {
  /** @scenario "The wake never waits on itself" */
  it("leaves out its own run and workflow", () => {
    assert.deepEqual(classify(greenCommit(), OWN), { kind: "green" });
  });

  it("leaves out its own check run and suite by name when its run is not listed yet", () => {
    const data = greenCommit();
    data.workflowRuns = data.workflowRuns.filter((run) => run.id !== 900);
    assert.deepEqual(classify(data, { excludeCheck: "review-bot-wake" }), { kind: "green" });
  });

  it("leaves out older wake runs on the same commit", () => {
    const data = greenCommit();
    data.workflowRuns.push(
      workflowRun(899, 90, "review-bot-wake", 899, { run_started_at: "2026-11-25T08:00:00Z" }),
    );
    data.checkSuites.push(suite(899));
    data.checkRuns.push(checkRun(899, "review-bot-wake", { conclusion: "cancelled" }));
    assert.deepEqual(classify(data, OWN), { kind: "green" });
  });
});

describe("given the wait loop", () => {
  const clock = () => {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  };

  /** @scenario "An API error round is never green" */
  it("treats a failed read as an unread round and tries again", async () => {
    const { now, sleep } = clock();
    const lines: string[] = [];
    let calls = 0;
    const outcome = await waitForChecks({
      read: async () => {
        calls += 1;
        if (calls === 1) throw new Error("GET check-runs answered 502");
        return greenCommit();
      },
      options: OWN,
      sleep,
      now,
      deadline: 45 * 60_000,
      intervalMs: 30_000,
      log: (line) => lines.push(line),
    });
    assert.equal(outcome, "green");
    assert.equal(calls, 2);
    assert.match(lines[0] ?? "", /Could not read the checks this round/);
  });

  /** @scenario "The 45-minute deadline wakes nothing" */
  it("ends at the deadline when reads keep failing or checks keep running", async () => {
    for (const read of [
      async (): Promise<Snapshot> => {
        throw new Error("network down");
      },
      async (): Promise<Snapshot> => {
        const data = greenCommit();
        data.checkRuns.push(checkRun(101, "slow", { status: "in_progress", conclusion: null }));
        return data;
      },
    ]) {
      const { now, sleep } = clock();
      const lines: string[] = [];
      const outcome = await waitForChecks({
        read,
        options: OWN,
        sleep,
        now,
        deadline: 45 * 60_000,
        intervalMs: 30_000,
        log: (line) => lines.push(line),
      });
      assert.equal(outcome, "deadline");
      assert.equal(now(), 45 * 60_000);
      assert.match(lines.at(-1) ?? "", /^::notice::.*after 45 minutes/);
    }
  });

  it("stops at the first red round", async () => {
    const { now, sleep } = clock();
    const lines: string[] = [];
    const data = greenCommit();
    data.statuses.push({ context: "vercel", state: "failure" });
    const outcome = await waitForChecks({
      read: async () => data,
      options: OWN,
      sleep,
      now,
      deadline: 45 * 60_000,
      intervalMs: 30_000,
      log: (line) => lines.push(line),
    });
    assert.equal(outcome, "red");
    assert.equal(now(), 30_000);
    assert.deepEqual(lines, ["::notice::Not waking the review bot: these checks did not pass: vercel"]);
  });
});

describe("given a paginated listing", () => {
  it("follows the next link until the listing ends", () => {
    assert.equal(
      nextPageUrl('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"'),
      "https://api.github.com/x?page=2",
    );
    assert.equal(nextPageUrl('<https://api.github.com/x?page=1>; rel="prev"'), null);
    assert.equal(nextPageUrl(null), null);
  });
});
