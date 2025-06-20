import { generate, parse } from "xksuid";

let batchRunId: string | null = null;

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
  if (!batchRunId) {
    batchRunId = process.env.SCENARIO_BATCH_RUN_ID ?? `scenariobatchrun_${generate()}`;
  }

  return batchRunId;
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
