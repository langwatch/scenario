import * as agents from "./agents";
import { configure } from "./config/configure";
import * as domain from "./domain";
import * as execution from "./execution";
import * as runner from "./runner";
import * as script from "./script";
import {
  pipecatAgent,
  openAIRealtimeAgent,
  geminiLiveAgent,
  elevenLabsAgent,
  twilioAgent,
  composableAgent,
} from "./voice/factories";

// Re-export all types and other named exports
export * from "./agents";
export * from "./domain";
export * from "./execution";
export * from "./runner";
export * from "./script";

// Voice subsystem — type contract surface (PR1) + TTS / STT plumbing (PR2)
// for issue #372. Adapter runtime / transports land in subsequent PRs
// behind this same contract.
export * as voice from "./voice";

// Global SDK execution settings (e.g. `scenario.configure({ audioPlayback })`).
// Provider config is per-run via `run({ voice })`, not here (ADR-002).
export { configure } from "./config/configure";
export type { ScenarioConfigureOptions } from "./config/configure";

// Tracing public API
export { setupScenarioTracing } from "./tracing/setup";
export { scenarioOnly, withCustomScopes } from "./tracing/filters";
export {
  ATTR_SCENARIO_SDK_NAME,
  ATTR_SCENARIO_SDK_VERSION,
  SCENARIO_SDK_NAME,
  SCENARIO_SDK_VERSION,
  scenarioSdkAttributes,
} from "./tracing/sdk-metadata";

// Red-team report public API (auto-save happens inside runner/run.ts;
// this export exists so users can manually invoke it if they're running
// scenarios outside the default runner).
export { saveRedTeamReport, isRedTeamAgent } from "./red-team-report";

// Voice adapter factories — the documented PRD §9 idiom on the `scenario`
// object (`scenario.pipecatAgent({...})`). `voice` also stays available as a
// namespace (above) for the full surface (effects, config types, etc.).
const voiceAgentFactories = {
  pipecatAgent,
  openAIRealtimeAgent,
  geminiLiveAgent,
  elevenLabsAgent,
  twilioAgent,
  composableAgent,
};

type ScenarioApi = typeof agents &
  typeof domain &
  typeof execution &
  typeof runner &
  typeof script &
  typeof voiceAgentFactories & {
    configure: typeof configure;
  };

export const scenario: ScenarioApi = {
  ...agents,
  ...domain,
  ...execution,
  ...runner,
  ...script,
  ...voiceAgentFactories,
  configure,
};

export default scenario;
