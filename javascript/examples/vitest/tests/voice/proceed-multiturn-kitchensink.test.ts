/**
 * VOICE KITCHEN-SINK — ONE scenario that exercises the voice-API surface end to
 * end against a HOSTED ElevenLabs agent, driven by an AUTONOMOUS realtime
 * (speech-native) user, and PROVES the artifacts are saved correctly.
 *
 * ONE SCENARIO: a single `scenario.run()` whose one script chains the
 * capabilities into a coherent customer call — verbatim user turn, time-based
 * barge-in (`interrupt({ after })`), silence handling, then a `proceed()`
 * stretch that SHOULD drive autonomous realtime-user turns (currently a no-op —
 * see rough edge [2]) — closed by the coherence judge. (The weaker `interrupt({ afterWords })` path is left OUT of
 * this single flow on purpose: it can throw `UnsupportedCapabilityError` and
 * would fail the whole scenario; probe it in isolation instead.)
 *
 * ARTIFACTS: after the run we save the recording AND assert it landed correctly
 * — `full.wav` + `manifest.json` + one WAV per segment, and EVERY segment must
 * carry a transcript (issue #705: transcripts were previously missing). This is
 * the on-disk twin of the LangWatch message snapshot.
 *
 * SKIP DISCIPLINE — `it.skipIf(!hasHostedKey)`, never `if (!key) return` (an
 * early return reports the test as PASSED — a hollow green). COHERENCE — turn
 * counts prove audio moved, not that the agents HEARD each other; the judge
 * carries {@link AGENTS_HEARD_EACH_OTHER}. PERSONA — the realtime user rides on
 * CUSTOMER_INSTRUCTIONS and the `description` is a plain call narrative with NO
 * framework jargon, since the simulator voices it.
 *
 * ⚠️ KNOWN ROUGH EDGES — this scenario PASSES, but the parts below are not
 * working perfectly yet. Each is flagged inline in the script:
 *   [1] `interrupt()` must follow a USER turn or its forced agent turn hangs to
 *       a `receiveAudio` timeout; and every realtime user turn carries ~15s of
 *       drain latency (the model's turn is only detected via an idle timeout).
 *   [2] The autonomous `proceed(N)` stretch drives ZERO turns here: on the wire
 *       `proceed(7)` at turn 3 scheduled no realtime-USER turn and went straight
 *       to the judge. NOT an N-sizing issue (7 > the elapsed 3) — the realtime
 *       user simply is not driven by `proceed()` yet (a #705 gap, tracked). The
 *       scripted turns carry the demo.
 *   [3] A very short user turn immediately before `silence()` may not be captured
 *       as its own recording segment (user message count can exceed user segment
 *       count).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import scenario, {
  AgentRole,
  voice,
  type ScenarioExecutionStateLike,
  type ScenarioResult,
} from "@langwatch/scenario";
import { describe, it, expect } from "vitest";

import { AGENTS_HEARD_EACH_OTHER } from "./helpers/judge-criteria";
import { saveDemoRecording } from "./helpers/save-demo-recording";

// `OPENAI_REALTIME_MODEL` is the default realtime model id, exported on the
// `voice` namespace.
const { OPENAI_REALTIME_MODEL } = voice;

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const hasHostedKey = Boolean(
  ELEVENLABS_API_KEY && ELEVENLABS_AGENT_ID && OPENAI_API_KEY,
);

// Persona + goal for the AUTONOMOUS realtime user — rides on the adapter
// `instructions`. Free of framework jargon so nothing framework-y is voiced.
const CUSTOMER_INSTRUCTIONS =
  "You are a customer who has called your bank's support line about your " +
  "account. You are the one being helped — you are NEVER the agent. Speak one " +
  "short, natural, first-person sentence per turn, in your own words: ask your " +
  "next question, or answer what the agent just asked. Do not offer assistance, " +
  "do not present menu options, and do not echo the agent's wording. Across the " +
  "call you want to check your balance, ask about a recent transaction, and " +
  "update a setting on your account.";

function realtimeUser() {
  return scenario.openAIRealtimeAgent({
    model: OPENAI_REALTIME_MODEL,
    voice: "marin",
    instructions: CUSTOMER_INSTRUCTIONS,
    role: AgentRole.USER,
  });
}

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
      let result: ScenarioResult | null = null;
      let caught: unknown = null;

      try {
        result = await scenario.run({
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
                // Load-bearing coherence gate: counts are not enough — the judge
                // must verify the agents actually HEARD each other.
                AGENTS_HEARD_EACH_OTHER,
                "The agent and user exchanged audio turns via the live WebSocket",
              ],
            }),
          ],
          script: [
            scenario.agent(), // EL greeting drains
            scenario.user("Hi, I have a question about my account balance."), // VERBATIM opener
            // ⚠️ ROUGH EDGE [1] — BARGE-IN (time): the agent starts REPLYING to
            // the opener and the user cuts in mid-reply. `interrupt` fires the
            // agent turn itself, so it MUST follow a USER turn the agent can
            // answer — placed after an agent turn, the forced agent turn has
            // nothing to say and `receiveAudio` hangs to a timeout (the framework
            // should validate this and fail fast; today it does not). NOTE also
            // that each realtime turn carries ~15s of drain latency.
            scenario.interrupt({
              after: 1.5,
              content:
                "sorry — actually, can you also tell me about my recent transactions?",
              waitForSpeechTimeout: 15,
            }),
            scenario.agent(), // agent responds to the barged-in request
            // ⚠️ ROUGH EDGE [3] — this short user turn immediately before
            // `silence()` was NOT captured as its own recording segment in
            // practice (user message count > user segment count). Audio moved on
            // the wire, but the recorder dropped this segment.
            scenario.user("Hmm, hold on a second."),
            scenario.silence(2.0), // SILENCE: silent PCM over the wire (dead air)
            scenario.user("Okay, I'm back — what's my current balance?"), // resume with a real question
            scenario.agent(), // agent answers the resumed question
            // Autonomous stretch: `proceed()` SHOULD let the realtime USER drive
            // the conversation on its own — the core #705 capability.
            // ⚠️ ROUGH EDGE [2] — but on the wire it drives ZERO turns: `proceed(7)`
            // at turn 3 scheduled no USER turn and went straight to the judge
            // (`onTurn` never fired). This is NOT the N-sizing footgun (7 > the
            // elapsed 3) — the realtime user simply is not driven by `proceed()`
            // yet (#705 gap). Kept to show the intended surface; the scripted
            // turns above carry the actual demo.
            scenario.proceed(7, logTurn),
            scenario.judge(), // COHERENCE GATE
          ],
          maxTurns: 18,
        });
      } catch (e) {
        caught = e;
      }

      // Fail LOUD on a thrown / null run rather than NPEing on result!.x.
      if (caught !== null || result === null) {
        const err =
          caught instanceof Error
            ? caught
            : new Error(String(caught ?? "scenario.run() returned null"));
        console.log(`[kitchensink] THREW → ${err.message}`);
        throw err;
      }

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
      expect(manifest.segments.length, "manifest lists segments").toBeGreaterThan(0);
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
