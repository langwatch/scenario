/**
 * Keep scenario runs in one browser tab instead of opening a new one every time.
 *
 * Running a suite in a loop used to leave a trail of twenty LangWatch tabs. The
 * fix has three layers, tried in order:
 *
 * 1. **Handoff.** LangWatch knows whether a simulations tab opened by this
 *    machine still has a live connection. If one does, the run is pushed to
 *    that tab and nothing is opened locally.
 * 2. **Throttle.** When the LangWatch instance is too old to answer that
 *    question, a small on-disk record keeps repeat runs of the same set from
 *    opening a second tab within a short window.
 * 3. **Policy.** `SCENARIO_BROWSER` (and the older `SCENARIO_HEADLESS`) decide
 *    whether a browser may be opened at all; CI never opens one.
 *
 * The state files are shared byte-for-byte with the Python SDK, so a tab opened
 * by `pytest` is reused by `vitest` and the other way around.
 *
 * Every step fails open: a broken handoff, an unwritable state directory, or a
 * missing browser must never disturb the scenario run itself.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import open from "open";
import { Logger } from "../utils/logger";

const logger = new Logger("scenario.browser.tabHandoff");

/** Query param carrying this machine's tab key into the page the SDK opens. */
export const SCENARIO_TAB_QUERY_PARAM = "scenarioTab";

/** How long the SDK waits on the handoff before giving up and opening a tab. */
export const HANDOFF_TIMEOUT_MS = 2000;

/**
 * Default window during which the same scenario set will not reopen a tab,
 * used only when the LangWatch instance cannot answer the handoff.
 */
export const DEFAULT_REOPEN_INTERVAL_SECONDS = 300;

export type BrowserPolicy = "auto" | "never" | "always";

export type BrowserOutcome =
  | "handed_off"
  | "opened"
  | "suppressed_by_policy"
  | "suppressed_by_throttle"
  | "failed_to_open";

export interface BatchRunLocation {
  batchUrl: string;
  batchRunId: string;
  scenarioSetId?: string;
}

function stateDir(): string {
  const override = process.env.LANGWATCH_STATE_DIR;
  if (override) return override;
  return path.join(os.homedir(), ".langwatch");
}

function isTruthy(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

/**
 * Decide the opening policy for this process.
 *
 * An explicit `SCENARIO_BROWSER` always wins, including over `headless`, so a
 * developer can force a tab open from a headless-by-default setup.
 */
export function resolveBrowserPolicy(headless = false): BrowserPolicy {
  const raw = (process.env.SCENARIO_BROWSER ?? "").trim().toLowerCase();

  if (raw) {
    if (raw === "auto" || raw === "never" || raw === "always") return raw;
    logger.warn(
      `Unrecognized SCENARIO_BROWSER=${raw}, expected one of auto/never/always; falling back to auto`
    );
    return "auto";
  }

  if (headless || isTruthy(process.env.CI)) return "never";

  return "auto";
}

/**
 * Stable identifier for this machine's scenario tab, created on first use.
 *
 * Returns null when the state directory cannot be used, which simply disables
 * reuse.
 */
export function scenarioTabKey(): string | null {
  const keyPath = path.join(stateDir(), "scenario-tab-key");

  try {
    const existing = fs.readFileSync(keyPath, "utf-8").trim();
    if (existing) return existing;
  } catch {
    // Not created yet.
  }

  const key = crypto.randomUUID().replace(/-/g, "");

  try {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    // Exclusive create: when two processes start at once, the loser reads the
    // winner's key instead of overwriting it.
    fs.writeFileSync(keyPath, key, { flag: "wx", encoding: "utf-8" });
    return key;
  } catch {
    try {
      return fs.readFileSync(keyPath, "utf-8").trim() || null;
    } catch {
      return null;
    }
  }
}

function reopenIntervalSeconds(): number {
  const raw = process.env.SCENARIO_BROWSER_REOPEN_SECONDS;
  if (!raw) return DEFAULT_REOPEN_INTERVAL_SECONDS;

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    logger.warn(`Ignoring non-numeric SCENARIO_BROWSER_REOPEN_SECONDS=${raw}`);
    return DEFAULT_REOPEN_INTERVAL_SECONDS;
  }

  return Math.max(0, parsed);
}

function throttlePath(): string {
  return path.join(stateDir(), "scenario-tab-opens.json");
}

function readThrottle(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(throttlePath(), "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries: Record<string, number> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "number") entries[key] = value;
      }
      return entries;
    }
  } catch {
    // No record yet, or an unreadable one — either way, nothing to honour.
  }
  return {};
}

function openedRecently(setKey: string, nowSeconds: number): boolean {
  const interval = reopenIntervalSeconds();
  if (interval <= 0) return false;

  const last = readThrottle()[setKey];
  return last !== void 0 && nowSeconds - last < interval;
}

function recordOpen(setKey: string, nowSeconds: number): void {
  const entries = readThrottle();
  entries[setKey] = nowSeconds;

  // Keep the file from growing forever on long-lived machines.
  const horizon = Math.max(reopenIntervalSeconds(), 1) * 10;
  const pruned: Record<string, number> = {};
  for (const [key, seen] of Object.entries(entries)) {
    if (nowSeconds - seen < horizon) pruned[key] = seen;
  }

  const target = throttlePath();
  const tmp = `${target}.${process.pid}.tmp`;

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(pruned), "utf-8");
    fs.renameSync(tmp, target);
  } catch (error) {
    logger.debug("Could not record the browser open time", { error });
  }
}

function withTabKey(url: string, tabKey: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set(SCENARIO_TAB_QUERY_PARAM, tabKey);
    return parsed.href;
  } catch {
    return url;
  }
}

/**
 * Ask LangWatch to push this batch to an already-open tab.
 *
 * Resolves true when a tab took it, false when none was listening, and null
 * when the instance cannot answer — an old server, a network hiccup — which
 * tells the caller to fall back to its own heuristics.
 */
async function requestHandoff(params: {
  endpoint: string;
  apiKey: string;
  projectId?: string;
  tabKey: string;
  location: BatchRunLocation;
}): Promise<boolean | null> {
  const { endpoint, apiKey, projectId, tabKey, location } = params;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (projectId) headers["X-Project-Id"] = projectId;

  const body: Record<string, string> = {
    tabKey,
    batchRunId: location.batchRunId,
  };
  if (location.scenarioSetId) body.scenarioSetId = location.scenarioSetId;

  try {
    const response = await fetch(
      new URL("/api/scenario-events/browser-tab", endpoint).href,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(HANDOFF_TIMEOUT_MS),
      }
    );

    // A LangWatch that predates the endpoint, or any other refusal: let the
    // caller fall back rather than guessing.
    if (!response.ok) {
      logger.debug(`Browser tab handoff returned ${response.status}`);
      return null;
    }

    const data = (await response.json()) as { delivered?: boolean };
    return Boolean(data.delivered);
  } catch (error) {
    logger.debug("Browser tab handoff request failed", { error });
    return null;
  }
}

/**
 * Put this batch of runs in front of the user, reusing their tab when possible.
 */
export async function showBatchRun(
  location: BatchRunLocation,
  options: {
    headless?: boolean;
    endpoint?: string;
    apiKey?: string;
    projectId?: string;
    /**
     * Exists so tests can watch what would have been opened; production callers
     * leave it alone and get the platform's default browser.
     */
    opener?: (url: string) => void;
  } = {}
): Promise<BrowserOutcome> {
  const { headless = false, endpoint, apiKey, projectId, opener } = options;
  const policy = resolveBrowserPolicy(headless);

  if (policy === "never") return "suppressed_by_policy";

  const tabKey = scenarioTabKey();

  if (policy === "auto" && tabKey && endpoint && apiKey) {
    const delivered = await requestHandoff({
      endpoint,
      apiKey,
      projectId,
      tabKey,
      location,
    });

    if (delivered === true) return "handed_off";

    if (delivered === false) {
      // Authoritative "no tab is listening": open one and skip the throttle,
      // which only exists for servers that cannot answer.
      return openTab(location, tabKey, opener);
    }
  }

  const nowSeconds = Date.now() / 1000;
  const setKey = location.scenarioSetId ?? location.batchUrl;

  if (policy === "auto" && openedRecently(setKey, nowSeconds)) {
    return "suppressed_by_throttle";
  }

  return openTab(location, tabKey, opener, { setKey, nowSeconds });
}

function openTab(
  location: BatchRunLocation,
  tabKey: string | null,
  opener?: (url: string) => void,
  record?: { setKey: string; nowSeconds: number }
): BrowserOutcome {
  const url = tabKey ? withTabKey(location.batchUrl, tabKey) : location.batchUrl;

  try {
    if (opener) opener(url);
    else void open(url);
  } catch (error) {
    logger.debug("Could not open a browser", { error });
    return "failed_to_open";
  }

  if (record) recordOpen(record.setKey, record.nowSeconds);

  return "opened";
}
