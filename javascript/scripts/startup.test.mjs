import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import module from "node:module";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

for (const format of ["js", "mjs"]) {
  // The fixture tracks ESM loads with module.registerHooks; without it the
  // ESM check would pass having watched nothing, so skip it visibly.
  const skip = format === "mjs" && !module.registerHooks && "needs module.registerHooks (Node 22.15+)";
  test(`${format}: import stays light and explicit tracing still initializes synchronously`, { skip }, () => {
    const entry = new URL(`../dist/index.${format}`, import.meta.url).href;
    const fixture = fileURLToPath(new URL("./startup-fixture.mjs", import.meta.url));
    assert.equal(execFileSync(process.execPath, [fixture, entry], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, LANGWATCH_API_KEY: "", LANGWATCH_ENDPOINT: "http://127.0.0.1:1" },
    }), "ready\n");
  });
}
