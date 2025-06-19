import { ScenarioProjectConfig } from "../domain";
import { loadScenarioProjectConfig } from "./load";
import { Logger } from "../utils/logger";

const logger = new Logger("scenario.config");

let configLoaded = false;
let config: ScenarioProjectConfig | null = null
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
      const loadedConfig = await loadScenarioProjectConfig();
      if (loadedConfig) {
        config = loadedConfig;
      }

      logger.info("loaded scenario project config", { config });
    } catch (error) {
      logger.error("error loading scenario project config", { error });
    } finally {
      configLoaded = true;
    }
  })();

  return configLoadPromise;
}

export async function getProjectConfig() {
  await loadProjectConfig();

  return config;
}
