/**
 * Voice kitchen-sink: ONE scenario that drives the voice-API surface end to end
 * against a hosted ElevenLabs agent with an autonomous realtime (speech-native)
 * user, then proves the saved artifacts are correct.
 *
 * The single `scenario.run()` chains a verbatim user opener, a time-based barge-in
 * (`interrupt({ after })`), silence handling, and a `proceed()` stretch, closed by
 * the coherence judge. After the run it saves the recording and asserts it landed:
 * `full.wav` + `manifest.json` + one WAV per segment, every segment carrying a
 * transcript (issue #705). Skip discipline is `it.skipIf(!hasHostedKey)` so a
 * keyless run reports SKIPPED, never a hollow PASSED. The judge carries
 * {@link AGENTS_HEARD_EACH_OTHER}: turn counts prove audio moved, not that the
 * agents heard each other. The realtime user rides on CUSTOMER_INSTRUCTIONS and the
 * `description` is a plain call narrative with no framework jargon, since the
 * simulator voices it.
 *
 * Known rough edges are flagged inline in the script:
 *   [1] `interrupt()` must follow a user turn or its forced agent turn hangs to a
 *       `receiveAudio` timeout, and every realtime user turn carries ~15s of drain
 *       latency.
 *   [2] the autonomous `proceed(N)` stretch does not yet drive realtime-user turns
 *       (a #705 gap); the scripted turns carry the demo.
 *   [3] a very short user turn immediately before `silence()` may not be captured as
 *       its own recording segment.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import scenario, {
  voice,
  type ScenarioExecutionStateLike,
} from "@langwatch/scenario";
import { describe, it, expect } from "vitest";

import { AGENTS_HEARD_EACH_OTHER } from "./helpers/judge-criteria";
import { realtimeUser } from "./helpers/realtime-user";
import { saveDemoRecording } from "./helpers/save-demo-recording";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const hasHostedKey = Boolean(
  ELEVENLABS_API_KEY && ELEVENLABS_AGENT_ID && OPENAI_API_KEY,
);

/** Per-turn logger for `proceed(turns, onTurn)` — exercises the callback and
 *  makes the autonomous stretch legible turn-by-turn in the run log. */
const logTurn = (state: ScenarioExecutionStateLike): void => {
  console.log(
    `[kitchensink] proceed turn ${state.currentTurn} — ${state.messages.length} messages so far`,
  );
};

describe("voice kitchen-sink — one scenario, full surface + artifact proof", () => {
  it.skipIf(!hasHostedKey)(
    "single scenario: verbatim+autonomous user, barge-in, silence, interruptions — coherent, artifacts saved",
    { retry: 0, timeout: 300_000 },
    async () => {
      const result = await scenario.run({
        name: "voice_kitchensink",
        description:
          "A customer calls their bank's support line about their account. " +
          "They greet the agent, ask about their balance, sometimes change " +
          "their mind partway through, pause for a moment, then work through " +
          "a couple more questions about their account.",
        agents: [
          scenario.elevenLabsAgent({
            agentId: ELEVENLABS_AGENT_ID!,
            apiKey: ELEVENLABS_API_KEY!,
          }),
          realtimeUser(),
          scenario.judgeAgent({
            criteria: [
              // Load-bearing coherence gate: counts are not enough; the judge
              // must verify the agents actually HEARD each other.
              AGENTS_HEARD_EACH_OTHER,
              "The agent and user exchanged audio turns via the live WebSocket",
            ],
          }),
        ],
        script: [
          scenario.agent(), // EL greeting drains
          scenario.user("Hi, I have a question about my account balance."), // VERBATIM opener
          // ⚠️ ROUGH EDGE [1], BARGE-IN (time): the agent starts REPLYING to
          // the opener and the user cuts in mid-reply. `interrupt` fires the
          // agent turn itself, so it MUST follow a USER turn the agent can
          // answer; placed after an agent turn, the forced agent turn has
          // nothing to say and `receiveAudio` hangs to a timeout (the framework
          // should validate this and fail fast; today it does not). NOTE also
          // that each realtime turn carries ~15s of drain latency.
          scenario.interrupt({
            after: 1.5,
            content:
              "sorry, actually, can you also tell me about my recent transactions?",
            waitForSpeechTimeout: 15,
          }),
          scenario.agent(), // agent responds to the barged-in request
          // ⚠️ ROUGH EDGE [3], this short user turn immediately before
          // `silence()` was NOT captured as its own recording segment in
          // practice (user message count > user segment count). Audio moved on
          // the wire, but the recorder dropped this segment.
          scenario.user("Hmm, hold on a second."),
          scenario.silence(2.0), // SILENCE: silent PCM over the wire (dead air)
          scenario.user("Okay, I'm back, what's my current balance?"), // resume with a real question
          scenario.agent(), // agent answers the resumed question
          // Autonomous stretch: `proceed()` SHOULD let the realtime USER drive
          // the conversation on its own, the core #705 capability.
          // ⚠️ ROUGH EDGE [2], but on the wire it drives ZERO turns: `proceed(7)`
          // at turn 3 scheduled no USER turn and went straight to the judge
          // (`onTurn` never fired). This is NOT the N-sizing footgun (7 > the
          // elapsed 3); the realtime user simply is not driven by `proceed()`
          // yet (#705 gap). Kept to show the intended surface; the scripted
          // turns above carry the actual demo.
          scenario.proceed(7, logTurn),
          scenario.judge(), // COHERENCE GATE
        ],
        maxTurns: 18,
      });

      const userTurns = result.messages.filter((m) => m.role === "user").length;
      const agentTurns = result.messages.filter(
        (m) => m.role === "assistant",
      ).length;

      // Save the recording. `result.audio` is typed as the VoiceRecording
      // interface (omits saveSegments) but IS a VoiceRecordingRuntime at runtime.
      const recordingDir = saveDemoRecording(
        result.audio as voice.VoiceRecordingRuntime | undefined,
        "voice_kitchensink",
        { downsampleHz: 8000 },
      );

      console.log(
        `[kitchensink] user=${userTurns} agent=${agentTurns} ` +
          `segments=${result.audio?.segments.length ?? 0} ` +
          `recording=${recordingDir ?? "<none>"} success=${result.success} ` +
          `reasoning=${result.reasoning ?? "<none>"}`,
      );

      // ---- Coherence gate --------------------------------------------------
      expect(
        result.success,
        `judge ruled the voiced conversation INCOHERENT — the agents did not ` +
          `clearly hear each other. reasoning: ${result.reasoning ?? "<none>"}`,
      ).toBe(true);

      // ---- Artifact-correctness gate --------------------------------------
      expect(recordingDir, "saveDemoRecording returned a directory").toBeTruthy();
      const dir = recordingDir!;
      const fullWav = join(dir, "full.wav");
      const manifestPath = join(dir, "manifest.json");
      expect(existsSync(fullWav), `full.wav exists at ${fullWav}`).toBe(true);
      expect(existsSync(manifestPath), `manifest.json exists at ${manifestPath}`).toBe(true);

      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        duration: number;
        segment_count: number;
        segments: Array<{ idx: number; role: string; file: string; transcript?: string }>;
      };
      // The script drives three user lines (the opener, the brief hold, the resumed
      // balance question) and an agent reply to each, so a real multi-turn run must
      // carry at least those three user turns and three agent turns.
      expect(
        userTurns,
        `expected the three scripted user turns; got ${userTurns}`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        agentTurns,
        `expected an agent reply to each scripted user turn; got ${agentTurns}`,
      ).toBeGreaterThanOrEqual(3);
      // Manifest is internally consistent and carries a real recording.
      expect(
        manifest.segment_count,
        "manifest segment_count matches the listed segments",
      ).toBe(manifest.segments.length);
      expect(manifest.duration, "recording has non-zero duration").toBeGreaterThan(0);

      // EVERY recorded segment must carry a transcript (issue #705: transcripts
      // were previously missing) AND its WAV file must exist on disk.
      for (const seg of manifest.segments) {
        expect(
          seg.transcript && seg.transcript.length > 0,
          `segment ${seg.idx} (${seg.role}) carries a transcript`,
        ).toBe(true);
        expect(
          existsSync(join(dir, seg.file)),
          `segment file ${seg.file} exists`,
        ).toBe(true);
      }

      // Recorded segments should account for at least the agent's spoken turns
      // — a large shortfall means audio is being dropped from the recording.
      expect(
        manifest.segments.length,
        `recorded segments (${manifest.segments.length}) cover the agent turns (${agentTurns})`,
      ).toBeGreaterThanOrEqual(agentTurns);
    },
  );
});
