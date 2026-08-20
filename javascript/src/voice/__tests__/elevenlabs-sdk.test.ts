/**
 * The ElevenLabs SDK must stay out of the module graph until voice runs.
 *
 * A module-scope `import ... from "@elevenlabs/elevenlabs-js"` anywhere under
 * `src/` puts it back into every consumer of the package, because `index.ts`
 * re-exports the voice namespace. That cost 4,972 modules and 237MB of RSS on
 * a plain `import "@langwatch/scenario"`, paid by text-only scenarios too.
 *
 * This is a source scan rather than a runtime check because the regression is
 * a static import, and a static import is exactly what a runtime probe of an
 * already-bundled build can no longer distinguish.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** javascript/src, from src/voice/__tests__/. */
const SRC = resolve(__dirname, "../..");

/** The seam is the one module allowed to name the SDK, and only in a body. */
const SEAM = "voice/elevenlabs-sdk.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === "__tests__" ? [] : sourceFiles(path);
    }
    return path.endsWith(".ts") && !path.endsWith(".d.ts") ? [path] : [];
  });
}

/** `import ... from "@elevenlabs/..."`, the static form. `import(...)` is fine. */
const STATIC_IMPORT = /^\s*import\s(?![^;]*\bfrom\s*\(\s*)[^;]*?from\s*["']@elevenlabs\//gm;

describe("given the package is imported without running voice", () => {
  describe("when a consumer imports the entry point", () => {
    it("loads no ElevenLabs module, because nothing imports the SDK statically", () => {
      const offenders = sourceFiles(SRC)
        .map((path) => ({ path, text: readFileSync(path, "utf8") }))
        .filter(({ text }) => STATIC_IMPORT.test(text))
        .map(({ path }) => relative(SRC, path));

      expect(
        offenders,
        `these modules import the ElevenLabs SDK at module scope, which pulls ~5k modules into every consumer. Route the call through ${SEAM} instead`,
      ).toEqual([]);
    });

    it("keeps the SDK reachable through the seam, so voice still works", () => {
      const seam = readFileSync(resolve(SRC, SEAM), "utf8");
      expect(seam).toMatch(/await import\(\s*\n?\s*["']@elevenlabs\//);
    });
  });
});
