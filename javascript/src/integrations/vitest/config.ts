import { defineConfig, type ViteUserConfig } from "vitest/config";

/**
 * Enhances a Vitest configuration with Scenario testing framework setup.
 *
 * This function wraps the provided Vitest configuration and automatically adds
 * the necessary setup files for Scenario testing. It ensures that both local
 * and global setup files are properly configured while preserving any existing
 * setup configuration.
 *
 * The function normalizes setup file configurations to handle different input formats:
 * - `undefined` → empty array
 * - string → array with single item
 * - array → array as-is
 *
 * @param config - The base Vitest configuration to enhance
 * @returns Enhanced Vitest configuration with Scenario setup files prepended
 *
 * @example
 * ```typescript
 * import { defineConfig } from 'vitest/config';
 * import { withScenario } from '@langwatch/scenario/integrations/vitest/config';
 *
 * export default withScenario(defineConfig({
 *   test: {
 *     setupFiles: ['./my-setup.ts'],
 *     globalSetup: ['./my-global-setup.ts']
 *   }
 * }));
 * ```
 *
 * @example
 * ```typescript
 * // Minimal configuration - only Scenario setup files
 * export default withScenario(defineConfig({}));
 * ```
 *
 * @since 1.0.0
 */
export function withScenario(config: ViteUserConfig) {
  // Normalize setupFiles to always be an array, handling undefined, string, or array inputs
  const normalizedSetupFiles =
    config.test?.setupFiles === void 0
      ? []
      : Array.isArray(config.test?.setupFiles)
      ? config.test?.setupFiles
      : [config.test?.setupFiles];

  // Normalize globalSetup to always be an array, handling undefined, string, or array inputs
  const normalizedGlobalSetup =
    config.test?.globalSetup === void 0
      ? []
      : Array.isArray(config.test?.globalSetup)
      ? config.test?.globalSetup
      : [config.test?.globalSetup];

  return defineConfig({
    ...config,
    test: {
      ...config.test,
      // Prepend Scenario setup files to ensure they run before user-defined setup
      setupFiles: [
        "@langwatch/scenario/integrations/vitest/setup",
        ...normalizedSetupFiles,
      ],
      // Prepend Scenario global setup files to ensure they run before user-defined global setup
      globalSetup: [
        "@langwatch/scenario/integrations/vitest/setup-global",
        ...normalizedGlobalSetup,
      ],
    },
  });
}
