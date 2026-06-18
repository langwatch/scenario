// Ungated CI guard for #638 / #567 — keyless, no live keys. Proves the hosted
// example is greeting-led multi-turn (AC8 updated: #567 fixed the adapter so
// multi-turn is now the expected shape), the composable example stays multi-turn
// (AC9), and the adapter timeout error is enriched with actionable guidance (AC6).

import * as fs from "node:fs";
import * as path from "node:path";

import { describe, it, expect } from "vitest";

const EXAMPLE_FILE = path.resolve(
  __dirname,
  "../../../examples/vitest/tests/voice/elevenlabs-hosted.test.ts",
);

const ADAPTER_FILE = path.resolve(__dirname, "../adapters/elevenlabs.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the `script: [ ... ]` block from a named Scenario block.
 * Finds the scenario by its title string, then locates the first `script: [`
 * that follows it, and walks forward counting bracket depth until the closing
 * `]` of the script array.
 */
function extractScriptBlock(source: string, scenarioTitle: string): string {
  const titleIdx = source.indexOf(scenarioTitle);
  if (titleIdx === -1) {
    throw new Error(
      `Guard: could not locate scenario "${scenarioTitle}" in example file — ` +
        `the guard regex needs updating or the scenario was renamed.`,
    );
  }

  const afterTitle = source.slice(titleIdx);

  // Find the first `script: [` after the title.
  const scriptMatch = afterTitle.match(/script:\s*\[/);
  if (!scriptMatch || scriptMatch.index === undefined) {
    throw new Error(
      `Guard: could not find "script: [" after scenario "${scenarioTitle}" — ` +
        `the example's script block shape changed.`,
    );
  }

  const scriptStart = scriptMatch.index + scriptMatch[0].length - 1; // position of the opening `[`
  let depth = 0;
  let end = -1;

  for (let i = scriptStart; i < afterTitle.length; i++) {
    if (afterTitle[i] === "[") depth++;
    else if (afterTitle[i] === "]") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end === -1) {
    throw new Error(
      `Guard: unbalanced brackets in script block for scenario "${scenarioTitle}".`,
    );
  }

  return afterTitle.slice(scriptStart, end + 1);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("elevenlabs-hosted-shape guard (#638)", () => {
  it("AC8 — hosted example is greeting-led multi-turn (#567 load-bearing proof)", () => {
    // Pre-#567: the adapter's server-VAD path timed out on the 2nd scripted user
    // turn, so the hosted example was capped at 1 user turn. Post-#567: the
    // adapter commits each user turn with an explicit user_message event, so
    // multi-turn works reliably. This guard now enforces the opposite invariant:
    // the hosted example MUST have ≥2 user turns (regression = reverting to 1).
    const source = fs.readFileSync(EXAMPLE_FILE, "utf-8");
    const block = extractScriptBlock(source, "Demo — ElevenLabs hosted Conversational AI");

    // Count occurrences of scenario.user( in the hosted script block.
    const userTurns = (block.match(/scenario\.user\(/g) ?? []).length;
    expect(userTurns).toBeGreaterThanOrEqual(2);

    // The FIRST scenario. step in the block must be scenario.agent() — greeting-led.
    // Strip leading `[` and whitespace, then match the first method call.
    const firstStepMatch = block.match(/scenario\.(\w+)\(/);
    expect(firstStepMatch).not.toBeNull();
    expect(firstStepMatch![1]).toBe("agent");
  });

  it("AC9 — composable/branded example proves multi-turn", () => {
    const source = fs.readFileSync(EXAMPLE_FILE, "utf-8");
    const block = extractScriptBlock(source, "Demo — ElevenLabs composable + branded agent");

    const userTurns = (block.match(/scenario\.user\(/g) ?? []).length;
    const agentTurns = (block.match(/scenario\.agent\(/g) ?? []).length;

    expect(userTurns).toBeGreaterThanOrEqual(2);
    expect(agentTurns).toBeGreaterThanOrEqual(2);
  });

  it("AC6 — adapter timeout error is enriched with context", () => {
    // Read the source (not the compiled output) and assert all three diagnostic
    // substrings appear. The message is spread across string literals joined by
    // `+`; normalize away the concatenation by stripping ` + ` boundaries.
    const source = fs.readFileSync(ADAPTER_FILE, "utf-8");
    // Collapse " +\n<whitespace>" joins so we can match across literal boundaries.
    const collapsed = source.replace(/"\s*\+\s*\n\s*"/g, "");

    expect(collapsed).toContain("receiveAudio timed out");
    // "Hosted ElevenLabs " lives in one literal, "ConvAI" in the next.
    // After collapsing the join both appear in sequence.
    expect(collapsed).toContain("Hosted ElevenLabs");
    expect(collapsed).toContain("ConvAI");
    // #567: the error now names the legacy silence-VAD path and recommends
    // the "text" mode; the old "single exchange" framing is retired.
    expect(collapsed).toContain("turnCommitMode");
  });
});
