import { defineConfig } from "vitest/config";
import VitestReporter from '@langwatch/scenario/reporters/vitest-reporter';

export default defineConfig({
  test: {
    testTimeout: 180000,
    reporters: [new VitestReporter],
  },
});
