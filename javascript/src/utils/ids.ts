import crypto from "node:crypto";
import process from "node:process";
import { generate, parse } from "xksuid";

let batchRunId: string | undefined;

/**
 * Generates a new thread ID.
 * @returns A new thread ID.
 */
export function generateThreadId(): string {
  return `thread_${generate()}`;
}

/**
 * Generates a new scenario run ID.
 * @returns A new scenario run ID.
 */
export function generateScenarioRunId(): string {
  return `scenariorun_${generate()}`;
}

/**
 * Generates a new scenario ID.
 * @returns A new scenario ID.
 */
export function generateScenarioId(): string {
  return `scenario_${generate()}`;
}

/**
 * Gets the batch run ID. If it's not set, it will be generated.
 * It can be set via the `SCENARIO_BATCH_RUN_ID` environment variable.
 * @returns The batch run ID.
 */
export function getBatchRunId(): string {
  // If the batch run id is already cached, use it
  if (batchRunId) {
    return batchRunId;
  }

  // If the batch run id is set in the environment, use it
  if (process.env.SCENARIO_BATCH_RUN_ID) {
    return (batchRunId = process.env.SCENARIO_BATCH_RUN_ID);
  }

  // If we are running inside a vitest (without global setup) or jest test runner, and
  // no batch run id is set, generate a new one using the parent process id.
  if (process.env.VITEST_WORKER_ID || process.env.JEST_WORKER_ID) {
    const parentProcessId = process.ppid;
    const now = new Date();
    const year = now.getUTCFullYear();
    const week = String(getISOWeekNumber(now)).padStart(2, "0");
    const raw = `${parentProcessId}_${year}_w${week}`;
    const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);

    return (batchRunId = `scenariobatchrun_${hash}`);
  }

  // Fallback to creating a new batch run id, and caching it
  return (batchRunId = `scenariobatchrun_${generate()}`);
}

/**
 * Returns the ISO week number for a given date.
 * @param date - The date to get the week number for.
 * @returns The ISO week number.
 */
function getISOWeekNumber(date: Date): number {
  const tmp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = tmp.getUTCDay() || 7;

  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);

  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);

  return weekNo;
}

/**
 * Generates a new message ID.
 * @returns A new message ID.
 */
export function generateMessageId(): string {
  return `scenariomsg_${generate()}`;
}

/**
 * Safely parses a xksuid string.
 * @param id - The xksuid string to parse.
 * @returns True if the xksuid string is valid, false otherwise.
 */
export const safeParseXKsuid = (id: string) => {
  try {
    parse(id);
    return true;
  } catch {
    return false;
  }
};
