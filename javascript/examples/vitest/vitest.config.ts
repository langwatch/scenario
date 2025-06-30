import VitestReporter from "@langwatch/scenario/integrations/vitest/reporter";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 180000,
    setupFiles: [
      '@langwatch/scenario/integrations/vitest/setup',
      'dotenv/config',
    ],
    globalSetup: [
      '@langwatch/scenario/integrations/vitest/setup-global',
    ],
    reporters: [
      'default',
      new VitestReporter(),
    ],
  },
});
