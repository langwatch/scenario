import { withScenario } from "@langwatch/scenario/integrations/vitest/config";
import { defineConfig } from "vitest/config";
import VitestReporter from "@langwatch/scenario/integrations/vitest/reporter";

export default withScenario(
  defineConfig({
    test: {
      testTimeout: 180_000, // 3 minutes
      setupFiles: ["dotenv/config"],
      // reporters: [new VitestReporter()],
    },
  })
);
