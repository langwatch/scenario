import { defineConfig, type ViteUserConfig } from "vitest/config";
import VitestReporter from "./reporter";

export function withScenario(config: ViteUserConfig) {
  const normalizedSetupFiles = config.test?.setupFiles === void 0
    ? []
    : Array.isArray(config.test?.setupFiles)
      ? config.test?.setupFiles
      : [config.test?.setupFiles];

  const normalizedGlobalSetup = config.test?.globalSetup === void 0
    ? []
    : Array.isArray(config.test?.globalSetup)
      ? config.test?.globalSetup
      : [config.test?.globalSetup];

  const normalizedReporters =
    config.test?.reporters === void 0
      ? []
      : Array.isArray(config.test?.reporters)
        ? config.test?.reporters
        : [config.test?.reporters];

  return defineConfig({
    ...config,
    test: {
      ...config.test,
      setupFiles: [
        '@langwatch/scenario/integrations/vitest/setup',
        ...normalizedSetupFiles,
      ],
      globalSetup: [
        '@langwatch/scenario/integrations/vitest/setup-global',
        ...normalizedGlobalSetup,
      ],
      reporters: [
        ...normalizedReporters,
        new VitestReporter(),
      ],
    },
  });
}
