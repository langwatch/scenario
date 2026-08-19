import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/integrations/vitest/*.ts"],
  // ai@7 publishes no CommonJS entry point, so the CJS build reaches it through
  // Node's require(esm), unflagged since Node 22.12 and ai@7 already requires
  // >=22. `smoke:dist` is what keeps that honest: if a future ai release adds
  // top-level await anywhere in its graph, require() starts throwing
  // ERR_REQUIRE_ASYNC_MODULE, and the smoke check fails the build instead of
  // the consumer's process.
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  external: ["vitest"],
  splitting: false,
  onSuccess:
    "node -e \"require('fs').cpSync('src/voice/assets', 'dist/voice/assets', { recursive: true })\"",
});
