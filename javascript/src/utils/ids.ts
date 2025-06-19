import { generate, parse } from "xksuid";

export function generateThreadId(): string {
  return `thread_${generate()}`;
}

export function generateScenarioRunId(): string {
  return `scenariorun_${generate()}`;
}

export function generateScenarioId(): string {
  return `scenario_${generate()}`;
}

export function getBatchRunId(): string {
  if (!process.env.SCENARIO_BATCH_ID) {
    process.env.SCENARIO_BATCH_ID = `scenariobatchrun_${generate()}`;
  }

  return process.env.SCENARIO_BATCH_ID;
}

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
