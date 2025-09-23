import { ScenarioProjectConfig } from "../domain";

export const DEFAULT_CONFIG: ScenarioProjectConfig = {
  headless: true,
  defaultModel: {
    model: "gpt-4o",
    temperature: 0.0,
  },
};
