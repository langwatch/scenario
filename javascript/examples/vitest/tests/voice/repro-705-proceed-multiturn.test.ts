// Faithful #705 fix proof — `scenario.proceed(N)` drives an AUTONOMOUS realtime
// USER (OpenAI Realtime, role=USER) through a multi-turn voiced conversation
// against a hosted ElevenLabs ConvAI agent. Realtime-to-realtime, no TTS on the
// user side.
//
// How it works (no new transport — "the scenario API as is"):
//  - The scripted opener `user("...")` is spoken VERBATIM by the realtime user
//    (the adapter's speakUserTurn → out-of-band response.create).
//  - `proceed(N)` then drives the realtime user AUTONOMOUSLY: the executor calls
//    the adapter's `call(role=USER)` each turn, which HEARS the EL agent's last
//    audio (appends it in-context) and SPEAKS a GENERATIVE next customer line
//    (one in-context response.create, fork B), returned as the user's audio turn.
//  - That audio reaches hosted EL, which commits the turn from the streamed
//    audio (its continuous mic pump) and replies in audio.
//
// Before the faithful fix, `call(role=USER)` REJECTED (autonomous realtime-user
// drive was "not supported yet"), so proceed() against a realtime user failed
// loud. Now it drives the conversation.
//
// COHERENCE vs COUNTS (Drew): counting utterances is NOT enough — a run can
// produce N user + M agent turns and still be incoherent (the agent talking past
// the user). The JUDGE-gated `it` below (proceed(3) + AGENTS_HEARD_EACH_OTHER) is
// the coherence proof. The counts-only `it` proves proceed ADVANCED the realtime
// user through multiple turns; it is explicitly NOT a coherence proof.
//
// Env-gated (self-skips without the 3 keys) + retry to absorb EL #708 silent-
// flakiness; NON-BLOCKING — runs in the `voice-integration` (hosted-EL) job, not
// the merge-blocking unit gate. Read the vitest SUMMARY line, not the workflow
// conclusion (memory: voice-e2e-hollow-green — `| tee` swallows the exit code).

import scenario, {
  AgentRole,
  voice,
  type ScenarioResult,
} from "@langwatch/scenario";
import { describe, it, expect } from "vitest";

import { AGENTS_HEARD_EACH_OTHER } from "./helpers/judge-criteria";
import { saveDemoRecording } from "./helpers/save-demo-recording";

const { OPENAI_REALTIME_MODEL } = voice;

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const hasHostedKey = Boolean(
  ELEVENLABS_API_KEY && ELEVENLABS_AGENT_ID && OPENAI_API_KEY,
);

function countSpeakers(result: ScenarioResult): { user: number; agent: number } {
  const segments = result.audio?.segments ?? [];
  return {
    user: segments.filter((s) => s.speaker === "user").length,
    agent: segments.filter((s) => s.speaker === "agent").length,
  };
}

/** Text carried by a conversation message (the transcript text part, or a plain
 *  string). Empty when an audio message reached the bus with no transcript. */
function messageText(m: { role: string; content: unknown }): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    const t = m.content.find(
      (p): p is { type: "text"; text: string } =>
        !!p && typeof p === "object" && (p as { type?: unknown }).type === "text",
    );
    return t?.text ?? "";
  }
  return "";
}

/**
 * Assert the conversation Drew saw broken in LangWatch is now coherent:
 *   (1) NO two consecutive same-role turns — the "doubled user-sim messages"
 *       defect (a scripted user() opener followed immediately by proceed()'s
 *       first autonomous USER turn, with the agent never replying between them).
 *   (2) EVERY agent turn carries a transcript — the "missing AUT transcript"
 *       defect (hosted-EL agent turns reaching the bus as audio-only).
 * Both assert on `result.messages` (= the MESSAGE_SNAPSHOT posted to LangWatch),
 * so a green run proves the posted data itself is clean — not just the audio.
 */
function assertCoherentConversation(result: ScenarioResult): void {
  const msgs = (result.messages ?? []).filter(
    (m) => m.role === "user" || m.role === "assistant",
  );
  // Never let this guard pass VACUOUSLY: an empty conversation (a framework
  // regression that stopped messages reaching state) would otherwise skip both
  // checks below silently — the hollow-green this whole gate exists to prevent.
  expect(
    msgs.length,
    "no user/assistant messages posted to result.messages",
  ).toBeGreaterThan(0);
  for (let i = 1; i < msgs.length; i++) {
    expect(
      msgs[i]!.role === msgs[i - 1]!.role,
      `doubled turn: messages ${i - 1} and ${i} are both '${msgs[i]!.role}' — ` +
        `the agent did not reply between two user turns (roles: ${msgs.map((m) => m.role).join(",")})`,
    ).toBe(false);
  }
  for (const m of msgs.filter((m) => m.role === "assistant")) {
    expect(
      messageText(m).trim().length,
      "an agent turn reached LangWatch with NO transcript (missing-AUT-transcript)",
    ).toBeGreaterThan(0);
  }
}

// Persona + goal for the AUTONOMOUS realtime user. With a realtime user (not a
// userSimulatorAgent) this rides on the adapter `instructions`; a per-turn nudge
// inside the adapter keeps the model in the customer role. Kept free of framework
// jargon so nothing framework-y can be voiced (memory:
// scenario-voice-description-is-sim-prompt).
const CUSTOMER_INSTRUCTIONS =
  "You are a customer who has called your bank's support line about your " +
  "account. You are the one being helped — you are NEVER the agent. Speak one " +
  "short, natural, first-person sentence per turn, in your own words: ask your " +
  "next question, or answer what the agent just asked. Do not offer assistance, " +
  "do not present menu options, and do not echo the agent's wording. Across the " +
  "call you want to check your balance, ask about a recent transaction, and " +
  "update a setting on your account.";

// Realtime USER simulator — the model itself speaks (role=USER), driven
// verbatim for the scripted opener and AUTONOMOUSLY for the proceed() turns.
function realtimeUser() {
  return scenario.openAIRealtimeAgent({
    model: OPENAI_REALTIME_MODEL,
    voice: "marin",
    instructions: CUSTOMER_INSTRUCTIONS,
    role: AgentRole.USER,
  });
}

describe("repro #705 — proceed(N) drives an autonomous realtime user on hosted EL", () => {
  it(
    "proceed(4) drives >=3 voiced realtime-user turns + >=3 agent replies (hosted EL)",
    { retry: 2, timeout: 300_000 },
    async () => {
      if (!hasHostedKey) {
        console.log(
          "SKIP: no hosted creds (ELEVENLABS_API_KEY/AGENT_ID + OPENAI_API_KEY)",
        );
        return;
      }

      let result: ScenarioResult | null = null;
      let caught: unknown = null;
      const turnsSeen: number[] = [];

      try {
        result = await scenario.run({
          name: "repro_705_proceed_realtime_user_multiturn",
          // In-character only — no framework jargon ("proceed", "ElevenLabs",
          // "WebSocket", "TTS"). With a realtime user this is not voiced, but
          // kept clean regardless.
          description:
            "A customer calls their bank's support line about their account. " +
            "They greet the agent, then ask a series of natural follow-up " +
            "questions about their balance, recent transactions, and account " +
            "settings across several turns.",
          agents: [
            scenario.elevenLabsAgent({
              agentId: ELEVENLABS_AGENT_ID!,
              apiKey: ELEVENLABS_API_KEY!,
            }),
            realtimeUser(),
          ],
          // Lead with the EL greeting, ONE scripted (verbatim) user opener, and
          // the agent's reply TO that opener, THEN let proceed(4) AUTONOMOUSLY
          // drive the realtime user for the rest. The explicit reply is
          // load-bearing: proceed() is USER-led, so a trailing scripted user()
          // immediately before it produces TWO adjacent user turns (the agent
          // only ingests the latest, so the opener is dropped) — the "doubled
          // user-sim messages" defect. Draining the reply first makes proceed
          // alternate cleanly (agent hears + answers every user turn). No judge
          // -> maxTurns bounds it, so every proceed turn runs and we can count
          // utterances cleanly.
          script: [
            scenario.agent(), // EL greeting drains
            scenario.user("Hi, I have a question about my account balance."),
            scenario.agent(), // EL answers the opener (keeps proceed alternating)
            scenario.proceed(4, (state) => {
              // onTurn only records the turn number — proof proceed advanced
              // through multiple turns (utterance counts come from the recording).
              turnsSeen.push(state.currentTurn);
            }),
          ],
          maxTurns: 12,
        });
      } catch (e) {
        caught = e;
      }

      if (caught) {
        console.log("[repro#705] THREW:", (caught as Error)?.message ?? caught);
      }
      console.log("[repro#705] proceed turns advanced:", JSON.stringify(turnsSeen));

      expect(caught, "proceed(N) autonomous realtime-user voice threw").toBeNull();
      expect(result, "scenario.run() returned no result").not.toBeNull();
      expect(result!.audio, "result.audio missing").toBeDefined();

      const { user: userTurns, agent: agentTurns } = countSpeakers(result!);
      const recordingDir = saveDemoRecording(result!.audio, "elevenlabs_proceed_705");

      // COUNT UTTERANCES — proves proceed advanced the realtime user. NOT a
      // coherence proof (that is the judged `it` below).
      console.log(
        `[repro#705] UTTERANCE COUNTS → user audio turns=${userTurns}, ` +
          `agent replies=${agentTurns}, total segments=${result!.audio!.segments.length}, ` +
          `recording=${recordingDir}`,
      );

      // proceed(4) after the scripted opener must yield a real multi-turn voiced
      // conversation: >=3 user audio turns AND >=3 agent replies. Before the fix,
      // proceed against a realtime user threw (autonomous drive unsupported).
      expect(
        userTurns,
        `expected >=3 voiced realtime-user turns from proceed(4); got ${userTurns}`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        agentTurns,
        `expected >=3 agent replies; got ${agentTurns}`,
      ).toBeGreaterThanOrEqual(3);

      // The posted conversation itself must be clean: no doubled user turns and
      // every agent turn carries its transcript (Drew's two LangWatch defects).
      assertCoherentConversation(result!);
    },
  );

  it(
    "proceed(3) + judge() proves the autonomous realtime user is COHERENT (hosted EL)",
    { retry: 2, timeout: 300_000 },
    async () => {
      if (!hasHostedKey) {
        console.log("SKIP: no hosted creds");
        return;
      }

      let result: ScenarioResult | null = null;
      let caught: unknown = null;

      try {
        result = await scenario.run({
          name: "repro_705_proceed_realtime_user_judged",
          description:
            "A customer calls their bank's support line about their account. " +
            "They greet the agent, then ask a few natural follow-up questions " +
            "about their account across several turns.",
          agents: [
            scenario.elevenLabsAgent({
              agentId: ELEVENLABS_AGENT_ID!,
              apiKey: ELEVENLABS_API_KEY!,
            }),
            realtimeUser(),
            scenario.judgeAgent({
              criteria: [
                // The load-bearing coherence gate (Drew): counts are not enough —
                // the judge must verify the agents actually HEARD each other.
                AGENTS_HEARD_EACH_OTHER,
                "The agent and user exchanged audio turns via the live WebSocket",
              ],
            }),
          ],
          script: [
            scenario.agent(), // EL greeting drains
            scenario.user("Hi, I have a question about my account balance."),
            scenario.agent(), // EL answers the opener (keeps proceed alternating)
            scenario.proceed(3),
            scenario.judge(),
          ],
          maxTurns: 12,
        });
      } catch (e) {
        caught = e;
      }

      if (caught) {
        console.log("[repro#705 judged] THREW:", (caught as Error)?.message ?? caught);
      }

      expect(caught, "judged proceed shape threw").toBeNull();
      expect(result, "scenario.run() returned no result").not.toBeNull();

      const { user: userTurns, agent: agentTurns } = countSpeakers(result!);
      console.log(
        `[repro#705 judged] UTTERANCE COUNTS → user audio turns=${userTurns}, ` +
          `agent replies=${agentTurns}, success=${result!.success}, ` +
          `reasoning=${result!.reasoning ?? "<none>"}`,
      );
      // COHERENCE GATE (Drew): counting utterances is NOT enough. The judge —
      // grading STT transcripts of the REAL audio (src/voice/judge-stt.ts) — must
      // rule that the agents actually heard each other (AGENTS_HEARD_EACH_OTHER).
      // A count-passing but incoherent run (agent talking past the user) fails
      // HERE instead of masquerading as a pass.
      expect(result!.audio?.segments.length ?? 0, "no audio segments").toBeGreaterThan(0);
      expect(
        result!.success,
        `judge ruled the voiced conversation INCOHERENT — the agents did not ` +
          `clearly hear each other. reasoning: ${result!.reasoning ?? "<none>"}`,
      ).toBe(true);

      // Belt-and-braces alongside the judge: the posted conversation must show
      // no doubled user turns and a transcript on every agent turn.
      assertCoherentConversation(result!);
    },
  );
});
