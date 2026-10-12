// Where the built JS SDK and its dependencies are. The benchmark has no
// package.json of its own: it loads the built package from ../../javascript
// (dist) and resolves dependencies (ai, @opentelemetry/sdk-trace-base) from
// that package's node_modules, so nothing new is installed and the very
// same module instances the SDK uses are loaded.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** benchmarks/go-vs-js */
export const BENCH_DIR = path.resolve(here, "..", "..");

/** The JS SDK package; SCENARIO_JS_DIR overrides it. */
export const JS_PKG_DIR = process.env.SCENARIO_JS_DIR
  ? path.resolve(process.env.SCENARIO_JS_DIR)
  : path.resolve(BENCH_DIR, "..", "..", "javascript");

/** The internals bundle js/build-internals.mjs writes. */
export const INTERNALS = path.join(BENCH_DIR, "js", ".build", "internals.mjs");

const NODE_CONDITIONS = new Set(["node", "import", "module-sync", "default"]);

// Picks the target of an exports entry the way Node's ESM resolver does:
// the first key, in object order, that is one of Node's import conditions.
function pickTarget(entry) {
  if (typeof entry === "string") return entry;
  if (Array.isArray(entry)) return pickTarget(entry[0]);
  if (entry && typeof entry === "object") {
    for (const [key, value] of Object.entries(entry)) {
      if (NODE_CONDITIONS.has(key)) {
        const t = pickTarget(value);
        if (t) return t;
      }
    }
  }
  return undefined;
}

/**
 * Resolves the ESM entry of a dependency of the JS SDK, as `import(spec)`
 * from javascript/dist would. Only the package root is supported.
 */
export function resolveDependency(spec) {
  const dir = path.join(JS_PKG_DIR, "node_modules", ...spec.split("/"));
  const pkgFile = path.join(dir, "package.json");
  if (!fs.existsSync(pkgFile)) {
    throw new Error(
      `${spec} not found under ${JS_PKG_DIR}/node_modules; run pnpm install in the javascript package first`
    );
  }
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  let target;
  if (pkg.exports !== undefined) {
    const root =
      typeof pkg.exports === "string" || Array.isArray(pkg.exports) || !("." in pkg.exports)
        ? pkg.exports
        : pkg.exports["."];
    target = pickTarget(root);
  }
  target ??= pkg.main ?? "index.js";
  return pathToFileURL(path.join(fs.realpathSync(dir), target)).href;
}

/** Imports a dependency of the JS SDK. */
export function importDependency(spec) {
  return import(resolveDependency(spec));
}

/** Imports the built SDK (ESM build, dist/index.mjs). */
export function importSdk() {
  const file = path.join(JS_PKG_DIR, "dist", "index.mjs");
  if (!fs.existsSync(file)) {
    throw new Error(`${file} is missing; build the javascript package first (pnpm run build)`);
  }
  return import(pathToFileURL(file).href);
}

/** Imports the internals bundle (see js/build-internals.mjs). */
export function importInternals() {
  if (!fs.existsSync(INTERNALS)) {
    throw new Error(`${INTERNALS} is missing; run node js/build-internals.mjs first`);
  }
  return import(pathToFileURL(INTERNALS).href);
}
