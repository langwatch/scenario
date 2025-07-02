import { ScenarioProjectConfig } from "../domain";
import { loadScenarioProjectConfig } from "./load";
import { Logger } from "../utils/logger";

const logger = new Logger("scenario.config");

let configLoaded = false;
let config: ScenarioProjectConfig | null = null;
let configLoadPromise: Promise<void> | null = null;

async function loadProjectConfig() {
  if (configLoaded) {
    return;
  }
  if (configLoadPromise) {
    return configLoadPromise;
  }

  configLoadPromise = (async () => {
    try {
      config = await loadScenarioProjectConfig();

      logger.debug("loaded scenario project config", { config });
    } catch (error) {
      logger.error("error loading scenario project config", { error });
    } finally {
      configLoaded = true;
    }
  })();

  return configLoadPromise;
}

/**
 * Gets the project config.
 * It will be loaded from the `scenario.config.js` file if it hasn't been loaded yet.
 * @returns The project config, or null if it could not be loaded.
 */
export async function getProjectConfig() {
  await loadProjectConfig();

  return config;
}
