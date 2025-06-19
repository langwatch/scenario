import { TestingAgentInferenceConfig } from "../agents/types";
import { ScenarioProjectConfig } from "../domain";

export function mergeConfig(config: TestingAgentInferenceConfig, projectConfig: ScenarioProjectConfig | null) {
  if (!projectConfig) {
    return config;
  }

  return {
    ...projectConfig.defaultModel,
    ...config,
  };
}

export function mergeAndValidateConfig(config: TestingAgentInferenceConfig, projectConfig: ScenarioProjectConfig | null) {
  const mergedConfig = mergeConfig(config, projectConfig);

  mergedConfig.model = mergedConfig.model ?? projectConfig?.defaultModel?.model;

  if (!mergedConfig.model) {
    throw new Error("Model is required");
  }

  return mergedConfig;
}
