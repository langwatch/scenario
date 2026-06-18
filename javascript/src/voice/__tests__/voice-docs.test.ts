/**
 * Documentation lint suite for voice-agent docs.
 *
 * Binds scenarios tagged `@docs` from `specs/voice-agents.feature`.
 * These scenarios assert that rendered documentation files stay in sync
 * with the adapter surface — they exercise filesystem I/O against markdown,
 * not runtime adapter behaviour, so they live here rather than in the voice
 * contract-surface suite.
 *
 * See issue #518 for the rationale behind the separation.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURE_PATH = resolve(HERE, "..", "..", "..", "..", "specs", "voice-agents.feature");
// Capability matrix is sourced from the published docs page (single
// source-of-truth across Python + TS). The wrapper page documents the
// adapters; the per-capability table itself is auto-generated from the
// Python declarations into _generated/ and imported by the wrapper.
const MATRIX_DOC_PATH = resolve(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "docs",
  "docs",
  "pages",
  "voice",
  "capability-matrix.mdx",
);
const GENERATED_MATRIX_PATH = resolve(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "docs",
  "docs",
  "pages",
  "_generated",
  "voice",
  "capability-matrix.mdx",
);

const feature = await loadFeature(FEATURE_PATH);

describeFeature(
  feature,
  ({ Scenario }) => {
    // -----------------------------------------------------------------------
    // Scenario: Capability matrix is rendered into adapter docs
    // -----------------------------------------------------------------------
    Scenario(
      "Capability matrix is rendered into adapter docs",
      ({ Given, Then, And }) => {
        let doc: string;

        Given("the voice-agents documentation", () => {
          // Wrapper page (adapter docs) + the auto-generated capability table
          // it imports — together they are "the documentation" for the matrix.
          doc =
            readFileSync(MATRIX_DOC_PATH, "utf8") +
            "\n" +
            readFileSync(GENERATED_MATRIX_PATH, "utf8");
        });

        Then("a capability matrix table lists every built-in adapter", () => {
          const adapters = [
            "PipecatAgentAdapter",
            "TwilioAgentAdapter",
            "OpenAIRealtimeAgentAdapter",
            "ElevenLabsAgentAdapter",
            "GeminiLiveAgentAdapter",
            "LiveKitAgentAdapter",
            "VapiAgentAdapter",
            "WebRTCAgentAdapter",
            "WebSocketAgentAdapter",
          ];
          for (const adapter of adapters) {
            expect(doc).toContain(adapter);
          }
        });

        And(
          "each row shows streaming_transcripts, native_vad, dtmf, input/output formats",
          () => {
            // The generated table's column headers — the literal capability
            // keys, exactly as the feature step names them.
            expect(doc.toLowerCase()).toContain("streaming_transcripts");
            expect(doc.toLowerCase()).toContain("native_vad");
            expect(doc.toLowerCase()).toContain("dtmf");
            expect(doc.toLowerCase()).toContain("input_formats");
            expect(doc.toLowerCase()).toContain("output_formats");
          },
        );
      },
    );
  },
  { includeTags: ["docs"] },
);
