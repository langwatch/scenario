import { defineConfig } from "vitest/config";
import VitestReporter from '@langwatch/scenario/integrations/vitest/reporter';

export default defineConfig({
  test: {
    testTimeout: 180000,
    setupFiles: ['@langwatch/scenario/integrations/vitest/setup'],
    reporters: [
      'default',
      new VitestReporter(),
    ],
  },
});
