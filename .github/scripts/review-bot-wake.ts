// Waits until the other checks on a pull request's head commit have finished,
// and says whether they all passed, so the review-bot-wake workflow knows
// whether to wake the Laze PR review bot.
//
// Every 30 seconds it reads the head commit's check runs, check suites, commit
// statuses and workflow runs, and hands them to classify(), a pure function
// that the tests drive with fixtures. Green ends the wait with green=true in
// GITHUB_OUTPUT; a red check ends it with a notice; the 45-minute deadline ends
// it with a notice too.
//
// Deliberately non-blocking: an API error is an unread round, never green, and
// anything unexpected is a warning with exit 0, so the job stays green.
//
// Deliberately dependency-free and run with `node --experimental-strip-types`:
// there is no install step on the runner.
//
// Spec: specs/review-bot-wake.feature

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type CheckRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  check_suite: { id: number } | null;
};

export type CheckSuite = {
  id: number;
  status: string;
  latest_check_runs_count: number;
  app: { slug: string } | null;
};

export type CommitStatus = { context: string; state: string };

export type WorkflowRun = {
  id: number;
  workflow_id: number;
  name: string;
  check_suite_id: number;
  status: string;
  created_at: string;
  /** When the latest attempt started; a re-run moves it, created_at stays. */
  run_started_at?: string | null;
};

export type Snapshot = {
  checkRuns: CheckRun[];
  checkSuites: CheckSuite[];
  statuses: CommitStatus[];
  workflowRuns: WorkflowRun[];
};

export type ClassifyOptions = {
  /** This job's own check run name: it would wait on itself. */
  excludeCheck: string;
  /** This workflow run's id (GITHUB_RUN_ID): its whole workflow is left out. */
  ownRunId?: number;
};

export type Verdict =
  | { kind: "green" }
  | { kind: "red"; failed: string[] }
  | { kind: "pending"; pending: string[] };

const BAD_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out"]);
const BAD_STATES = new Set(["failure", "error"]);

const startedAt = (run: WorkflowRun): string =>
  run.run_started_at ?? run.created_at;

/** The newest workflow run of each workflow on the commit: the one whose
 * latest attempt started last. Ordering by run_number is wrong here: a
 * re-run of an older run starts after a newer run and cancels it through the
 * workflow's concurrency group, and then the older run is the live one. */
export const latestRunPerWorkflow = (runs: WorkflowRun[]): WorkflowRun[] => {
  const latest = new Map<number, WorkflowRun>();
  for (const run of runs) {
    const seen = latest.get(run.workflow_id);
    if (
      !seen ||
      startedAt(run) > startedAt(seen) ||
      (startedAt(run) === startedAt(seen) && run.id > seen.id)
    ) {
      latest.set(run.workflow_id, run);
    }
  }
  return [...latest.values()];
};

/** Judges one read of the head commit.
 *
 * - Only the newest workflow run of each workflow counts. Check runs and
 *   suites of an older run of the same workflow on this commit (one cancelled
 *   by a later run's concurrency group, say) are ignored.
 * - Within a suite only the newest check run of each name counts (a re-run of
 *   a job supersedes the old one). Same-named jobs in different workflows are
 *   different suites and are judged apart.
 * - A check suite or workflow run still running counts as pending, so a
 *   workflow whose next job has no check run yet is waited for. Suites with no
 *   check run at all (apps that never report) are left out.
 * - This job's own check run and its own workflow are left out.
 * - Any failed, cancelled or timed-out check run, or a failed or errored
 *   commit status, makes the verdict red, even while others still run. */
export const classify = (
  snapshot: Snapshot,
  { excludeCheck, ownRunId }: ClassifyOptions,
): Verdict => {
  const ownWorkflow = snapshot.workflowRuns.find((run) => run.id === ownRunId)
    ?.workflow_id;
  const latest = latestRunPerWorkflow(snapshot.workflowRuns).filter(
    (run) => run.workflow_id !== ownWorkflow,
  );
  const live = new Set(latest.map((run) => run.check_suite_id));
  // Suites of workflow runs that are not judged: older runs of a workflow,
  // and every run of this workflow. Suites no workflow run names (other
  // apps) are judged as they are.
  const ignored = new Set(
    snapshot.workflowRuns
      .map((run) => run.check_suite_id)
      .filter((suite) => !live.has(suite)),
  );
  const workflowOf = new Map(latest.map((run) => [run.check_suite_id, run.name]));
  const labelOf = (suite: number | undefined, name: string): string => {
    const workflow = suite === undefined ? undefined : workflowOf.get(suite);
    return workflow ? workflow + " / " + name : name;
  };

  const own = new Set(
    snapshot.checkRuns
      .filter((run) => run.name === excludeCheck)
      .map((run) => run.check_suite?.id),
  );

  const newestRun = new Map<string, CheckRun>();
  for (const run of snapshot.checkRuns) {
    const suite = run.check_suite?.id;
    if (run.name === excludeCheck) continue;
    if (suite !== undefined && ignored.has(suite)) continue;
    const key = String(suite) + "\u0000" + run.name;
    const seen = newestRun.get(key);
    if (!seen || run.id > seen.id) newestRun.set(key, run);
  }

  const failed: string[] = [];
  const pending: string[] = [];
  for (const run of newestRun.values()) {
    const label = labelOf(run.check_suite?.id, run.name);
    if (run.status !== "completed") pending.push(label);
    else if (BAD_CONCLUSIONS.has(run.conclusion ?? "")) failed.push(label);
  }
  for (const suite of snapshot.checkSuites) {
    if (suite.latest_check_runs_count <= 0) continue;
    if (ignored.has(suite.id) || own.has(suite.id)) continue;
    if (suite.status !== "completed") {
      pending.push(workflowOf.get(suite.id) ?? (suite.app?.slug ?? "unknown") + " check suite");
    }
  }
  for (const run of latest) {
    if (run.status !== "completed") pending.push(run.name);
  }
  for (const status of snapshot.statuses) {
    if (status.state === "pending") pending.push(status.context);
    else if (BAD_STATES.has(status.state)) failed.push(status.context);
  }

  if (failed.length > 0) return { kind: "red", failed: [...new Set(failed)].sort() };
  if (pending.length > 0) return { kind: "pending", pending: [...new Set(pending)].sort() };
  return { kind: "green" };
};

export type WaitOutcome = "green" | "red" | "deadline";

/** Polls until classify() says green or red, or the deadline passes. A round
 * whose read throws is unread: it logs and tries again, never green. */
export const waitForChecks = async ({
  read,
  options,
  sleep,
  now,
  deadline,
  intervalMs,
  log,
}: {
  read: () => Promise<Snapshot>;
  options: ClassifyOptions;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  deadline: number;
  intervalMs: number;
  log: (line: string) => void;
}): Promise<WaitOutcome> => {
  for (;;) {
    // The first sleep also gives checks started by the same push time to register.
    await sleep(intervalMs);
    let verdict: Verdict | null = null;
    try {
      verdict = classify(await read(), options);
    } catch (error) {
      log("Could not read the checks this round (" + String(error) + "); trying again.");
    }
    if (verdict?.kind === "red") {
      log("::notice::Not waking the review bot: these checks did not pass: " + verdict.failed.join(", "));
      return "red";
    }
    if (verdict?.kind === "green") return "green";
    if (verdict?.kind === "pending") log("Waiting for: " + verdict.pending.join(", "));
    if (now() >= deadline) {
      log("::notice::Not waking the review bot: checks not all finished (or not readable) after 45 minutes.");
      return "deadline";
    }
  }
};

/** GitHub's Link header is the only reliable end-of-listing signal. */
export const nextPageUrl = (linkHeader: string | null): string | null => {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match?.[1]) return match[1];
  }
  return null;
};

const listAll = async <T>(url: string, key: string, token: string): Promise<T[]> => {
  const items: T[] = [];
  let next: string | null = url;
  while (next) {
    const response: Response = await fetch(next, {
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("GET " + next + " answered " + response.status);
    const body = (await response.json()) as Record<string, unknown>;
    const page = body[key];
    if (!Array.isArray(page)) throw new Error("GET " + next + " has no " + key);
    items.push(...(page as T[]));
    next = nextPageUrl(response.headers.get("link"));
  }
  return items;
};

export const readSnapshot = async ({
  apiUrl,
  repository,
  headSha,
  token,
}: {
  apiUrl: string;
  repository: string;
  headSha: string;
  token: string;
}): Promise<Snapshot> => {
  const commit = apiUrl + "/repos/" + repository + "/commits/" + headSha;
  const [checkRuns, checkSuites, statuses, workflowRuns] = await Promise.all([
    listAll<CheckRun>(commit + "/check-runs?per_page=100", "check_runs", token),
    listAll<CheckSuite>(commit + "/check-suites?per_page=100", "check_suites", token),
    listAll<CommitStatus>(commit + "/status?per_page=100", "statuses", token),
    listAll<WorkflowRun>(
      apiUrl + "/repos/" + repository + "/actions/runs?head_sha=" + headSha + "&per_page=100",
      "workflow_runs",
      token,
    ),
  ]);
  return { checkRuns, checkSuites, statuses, workflowRuns };
};

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(name + " is not set");
  return value;
};

const run = async (): Promise<void> => {
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const repository = requireEnv("GITHUB_REPOSITORY");
  const headSha = requireEnv("HEAD_SHA");
  const token = requireEnv("GITHUB_TOKEN");
  const ownRunId = Number(process.env.GITHUB_RUN_ID) || undefined;
  const outcome = await waitForChecks({
    read: () => readSnapshot({ apiUrl, repository, headSha, token }),
    options: { excludeCheck: requireEnv("EXCLUDE_CHECK"), ownRunId },
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => Date.now(),
    deadline: Date.now() + 45 * 60 * 1000,
    intervalMs: 30 * 1000,
    log: (line) => console.log(line),
  });
  if (outcome === "green") {
    console.log("All checks on " + headSha.slice(0, 7) + " finished green.");
    appendFileSync(requireEnv("GITHUB_OUTPUT"), "green=true\n");
  }
};

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  run().catch((error) => {
    // Even an unexpected failure only warns: see the non-blocking note above.
    console.log("::warning title=review-bot-wake::" + String(error));
  });
}
