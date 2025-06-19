import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ScenarioProjectConfig, scenarioProjectConfigSchema } from "../domain";

export async function loadScenarioProjectConfig(): Promise<ScenarioProjectConfig | null> {
  const cwd = process.cwd();
  const configNames = [
    "scenario.config.js",
    "scenario.config.mjs",
  ];

  for (const name of configNames) {
    const fullPath = path.join(cwd, name);
    try {
      await fs.access(fullPath);
      const configModule = await import(pathToFileURL(fullPath).href);
      const config = configModule.default || configModule;

      const parsed = scenarioProjectConfigSchema.safeParse(config);
      if (!parsed.success) {
        throw new Error(
          `Invalid config file ${name}: ${JSON.stringify(parsed.error.format(), null, 2)}`
        );
      }

      return parsed.data;
    } catch (error) {
      // Ignore only file-not-found errors
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }

      throw error;
    }
  }

  return null;
}
