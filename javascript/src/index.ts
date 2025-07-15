import * as agents from "./agents";
import * as domain from "./domain";
import * as execution from "./execution";
import * as runner from "./runner";
import * as script from "./script";

// Re-export all types and other named exports
export * from "./agents";
export * from "./domain";
export * from "./execution";
export * from "./runner";
export * from "./script";

type ScenarioApi = typeof agents &
  typeof domain &
  typeof execution &
  typeof runner &
  typeof script;

export const scenario: ScenarioApi = {
  ...agents,
  ...domain,
  ...execution,
  ...runner,
  ...script,
};

export default scenario;
