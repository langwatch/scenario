import { TestingAgentInferenceConfig } from "../agents/types";
import { ScenarioProjectConfig } from "../domain";

/**
 * Merges the agent's inference config with the project's default model config.
 * The agent's config takes precedence.
 * @param config The agent's inference config.
 * @param projectConfig The project's config.
 * @returns The merged config.
 */
export function mergeConfig(config: TestingAgentInferenceConfig, projectConfig: ScenarioProjectConfig | null) {
  if (!projectConfig) {
    return config;
  }

  return {
    ...projectConfig.defaultModel,
    ...config,
  };
}

/**
 * Merges the agent's inference config with the project's default model config,
 * and validates that a model is set.
 * @param config The agent's inference config.
 * @param projectConfig The project's config.
 * @returns The merged and validated config.
 * @throws An error if no model is set in the merged config.
 */
export function mergeAndValidateConfig(config: TestingAgentInferenceConfig, projectConfig: ScenarioProjectConfig | null) {
  const mergedConfig = mergeConfig(config, projectConfig);

  mergedConfig.model = mergedConfig.model ?? projectConfig?.defaultModel?.model;

  if (!mergedConfig.model) {
    throw new Error("Model is required");
  }

  return mergedConfig;
}
