import { generate, parse } from "xksuid";

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

/**
 * Gets the scenario batch ID for a scenario run. The scenario batch ID should be
 * the same for the current process, and should be unique across processes.
 *
 * @returns A string representing the scenario batch ID.
 */
export const getBatchId = (): string => {
  if (!process.env.SCENARIO_BATCH_ID) {
    process.env.SCENARIO_BATCH_ID = `scenariobatch_${generate()}`;
  }

  return process.env.SCENARIO_BATCH_ID;
};
