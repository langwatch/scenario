import { createRequire } from "node:module";
import type { SetupObservabilityOptions } from "langwatch/observability/node";

const requireFromHere = createRequire(
  typeof __filename === "string" ? __filename : import.meta.url,
);

/** Keep setup synchronous without loading the Node SDK when Scenario is imported. */
export function setupNodeObservability(
  options: Partial<SetupObservabilityOptions>,
): void {
  const { setupObservability } = requireFromHere("langwatch/observability/node") as
    typeof import("langwatch/observability/node");

  setupObservability(options);
}
