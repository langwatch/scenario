// Read the package version from package.json so it stays a single source of
// truth. tsup/esbuild inlines this JSON import at build time into a literal,
// mirroring how the langwatch observability SDK reads its own `version`
// (`import { version } from "../../package.json"`). This keeps ESM and CJS
// builds working with no custom build step and no `fs`/`require` at runtime.
import pkg from "../../package.json";

/**
 * OpenTelemetry attribute key for the scenario SDK name.
 * Mirrors langwatch's `langwatch.sdk.name` naming convention.
 */
export const ATTR_SCENARIO_SDK_NAME = "scenario.sdk.name";

/**
 * OpenTelemetry attribute key for the scenario SDK version.
 * Mirrors langwatch's `langwatch.sdk.version` naming convention.
 */
export const ATTR_SCENARIO_SDK_VERSION = "scenario.sdk.version";

/**
 * The scenario SDK name, stamped on every scenario-emitted trace so a run can
 * be identified as produced by `@langwatch/scenario` from its trace alone.
 * Sourced from package.json (single source of truth), not a hardcoded literal.
 */
export const SCENARIO_SDK_NAME: string = pkg.name;

/**
 * The installed `@langwatch/scenario` version, read from package.json.
 *
 * Note: no `scenario.sdk.commit` is emitted. A commit SHA is not cleanly
 * available at build/publish time (package.json carries no `gitHead`, and there
 * is no git context during publish without adding a custom build step), so it
 * is intentionally omitted. See issue #733 investigation.
 */
export const SCENARIO_SDK_VERSION: string = pkg.version;

/**
 * The SDK-identity attributes stamped on scenario trace spans (e.g. the
 * top-level `Scenario Turn` span). Attaching these as span attributes — rather
 * than resource attributes — means the identity travels with the span whenever
 * it is exported, covering both the SDK-owned exporter path and the case where
 * a consuming app configures its own OTEL exporter.
 *
 * Computed once at module load (the values are constants), so referencing it
 * costs no per-span allocation.
 */
export const scenarioSdkAttributes: Readonly<Record<string, string>> = {
  [ATTR_SCENARIO_SDK_NAME]: SCENARIO_SDK_NAME,
  [ATTR_SCENARIO_SDK_VERSION]: SCENARIO_SDK_VERSION,
};
