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

// Tracing public API
export { setupScenarioTracing } from "./tracing/setup";
export { scenarioOnly, withCustomScopes } from "./tracing/filters";

// Red-team report public API (auto-save happens inside runner/run.ts;
// this export exists so users can manually invoke it if they're running
// scenarios outside the default runner).
export { saveRedTeamReport, isRedTeamAgent } from "./red-team-report";

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
