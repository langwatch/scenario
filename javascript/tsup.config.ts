import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/integrations/vitest/*.ts"],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  external: ["vitest"],
  splitting: false,
  onSuccess:
    "node -e \"require('fs').cpSync('src/voice/assets', 'dist/voice/assets', { recursive: true })\"",
});
