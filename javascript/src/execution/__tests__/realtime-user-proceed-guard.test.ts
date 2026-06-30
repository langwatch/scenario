/**
 * Executor FAIL-CLOSED INVARIANT (#705) — a USER turn produced for a VOICE agent
 * under test MUST carry audio, or the run fails loud rather than silently
 * degrading the user side to a text turn the agent can't hear.
 *
 * This REPLACES the old `isRealtimeUserAgent` type-check with an adapter-AGNOSTIC
 * audio-presence assertion on the FINAL (post-voiceify) user turn. It is strictly
 * stronger: it trips on the produced ARTIFACT (no audio), regardless of producer
 * type. Coverage:
 *  - AC4 necessity: a producer that is NEITHER a realtime user NOR a voice
 *    user-sim, returning a no-audio (text) turn, ALSO fails — the case the OLD
 *    type-check let through silently.
 *  - AC4 sufficiency: a non-realtime producer returning AUDIO does NOT throw and
 *    the agent under test receives the audio.
 *  - realtime user returning TEXT still fails (kept) — but it is NOT sufficient
 *    alone (it trips both the old and new checks).
 *  - Must-Fix 3 (voice-user-sim regression): a voice user-sim returning TEXT is
 *    TTS'd to audio FIRST, so it broadcasts audio and does NOT throw.
 *  - the scripted user() path (speakUserTurn) is unaffected.
 *
 * Offline — no network, no real keys.
 */

import { describe, it, expect } from "vitest";

import {
  AgentRole,
  AgentAdapter,
  type AgentInput,
  type AgentReturnTypes,
} from "../../domain";
import { ScenarioExecution } from "../scenario-execution";
import { user, agent, proceed } from "../../script";
import { USER_TURN_NO_AUDIO_FOR_VOICE_AUT } from "../../domain/agents/agent-shapes";
import { AudioChunk } from "../../voice/audio-chunk";
import { createAudioMessage, messageHasAudio } from "../../voice/messages";
import { FakeVoiceAdapter } from "../../voice/__tests__/fixtures/fake-adapter";

/** Non-silent PCM16 audio user turn (200 bytes). */
function audioUserTurn(transcript: string): AgentReturnTypes {
  return createAudioMessage(
    new AudioChunk({ data: new Uint8Array(200), transcript }),
    "user",
  );
}

/**
 * A realtime USER agent that does NOT self-reject: satisfies
 * `isRealtimeUserAgent` (has both `sendText` and `speakUserTurn`) and returns a
 * generated TEXT turn from `call()`. The autonomous OpenAI adapter returns AUDIO
 * here; this fake (a hypothetical non-OpenAI realtime adapter) returns text and
 * must still fail loud.
 */
class FakeRealtimeUserReturningText extends AgentAdapter {
  override role = AgentRole.USER;

  override async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return { role: "user" as const, content: "generated user turn" };
  }

  async sendText(_text: string): Promise<void> {
    /* no-op: the proceed() path never reaches here */
  }

  async speakUserTurn(
    text: string,
  ): Promise<{ data: Uint8Array; transcript?: string }> {
    // Non-empty PCM16 so the scripted path produces real audio bytes.
    return { data: new Uint8Array(200), transcript: text };
  }
}

/**
 * A producer that is NEITHER a realtime user NOR a voice user-sim, returning a
 * TEXT turn. The OLD `isRealtimeUserAgent` type-check let this through silently
 * (it is not realtime, and not a voice-sim, so it fell to the `return messages`
 * branch → text broadcast). The audio-presence invariant catches it.
 */
class PlainTextUser extends AgentAdapter {
  override role = AgentRole.USER;
  override async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return { role: "user" as const, content: "generated text turn" };
  }
}

/** A non-realtime, non-voice-sim producer that returns AUDIO directly. */
class PlainAudioUser extends AgentAdapter {
  override role = AgentRole.USER;
  override async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return audioUserTurn("I want to check my balance.");
  }
}

/** A producer whose turn carries an EMPTY audio part and NO transcript — the
 *  #708-flake artifact. `messageHasAudio` returns true for a zero-byte part, so
 *  the invariant must test real content (bytes OR transcript), not audio-part
 *  presence, or this feeds the AUT silence → a receiveAudio-timeout hang. */
class EmptyAudioUser extends AgentAdapter {
  override role = AgentRole.USER;
  override async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return createAudioMessage(new AudioChunk({ data: new Uint8Array(0) }), "user");
  }
}

/**
 * A VOICE user simulator (satisfies `isVoiceUserSim`: non-empty `voice` +
 * `voiceifyText`) whose `call()` returns TEXT — the production user-simulator
 * shape during proceed(). voiceifyGeneratedUserTurn must TTS it to audio BEFORE
 * the audio-presence invariant runs, so it broadcasts audio and never throws.
 */
class VoiceSimReturningText extends AgentAdapter {
  override role = AgentRole.USER;
  readonly voice = "openai/nova";

  override async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return { role: "user" as const, content: "I'd like to check my balance." };
  }

  // Offline TTS stub: text → audio message.
  async voiceifyText(text: string): Promise<ReturnType<typeof createAudioMessage>> {
    return createAudioMessage(
      new AudioChunk({ data: new Uint8Array(200), transcript: text }),
      "user",
    );
  }
}

describe("executor user-turn audio-presence invariant (#705)", () => {
  it("AC4 necessity: a NON-realtime, NON-voice-sim producer returning text fails loud (the old type-check missed this)", async () => {
    const execution = new ScenarioExecution(
      {
        name: "plain-text-user-proceed",
        description: "a text user turn must not silently reach a voice agent",
        agents: [new FakeVoiceAdapter(), new PlainTextUser()],
      },
      [proceed(1)],
      "batch-test",
    );

    // callAgent re-wraps as `[agentName] ...`, so the message contains the shared
    // invariant const (asserted directly, not a brittle substring).
    await expect(execution.execute()).rejects.toThrow(
      USER_TURN_NO_AUDIO_FOR_VOICE_AUT,
    );
  });

  it("a CONTENT-LESS user turn (empty audio, no transcript) fails loud — messageHasAudio would wrongly pass it", async () => {
    const execution = new ScenarioExecution(
      {
        name: "empty-audio-user-proceed",
        description: "an empty-audio, no-transcript turn must not reach the voice agent",
        agents: [new FakeVoiceAdapter(), new EmptyAudioUser()],
      },
      [proceed(1)],
      "batch-test",
    );

    // A zero-byte audio part still satisfies messageHasAudio; the real-content
    // invariant (bytes OR transcript) is what catches this and fails loud.
    await expect(execution.execute()).rejects.toThrow(
      USER_TURN_NO_AUDIO_FOR_VOICE_AUT,
    );
  });

  it("AC4 sufficiency: a NON-realtime producer returning AUDIO does NOT throw and broadcasts audio", async () => {
    const execution = new ScenarioExecution(
      {
        name: "plain-audio-user-proceed",
        description: "an audio user turn reaches the voice agent",
        agents: [new FakeVoiceAdapter(), new PlainAudioUser()],
      },
      [proceed(1)],
      "batch-test",
    );

    await expect(execution.execute()).resolves.toBeDefined();
    // proceed(1) runs the USER step; the broadcast is observable in the
    // conversation history. The user turn reached the bus as AUDIO (an audio
    // part), not a degraded text turn — the sufficiency half of the invariant.
    const userAudioTurns = execution.messages.filter(
      (m) => m.role === "user" && messageHasAudio(m),
    );
    expect(userAudioTurns.length).toBeGreaterThan(0);
  });

  it("a realtime user returning TEXT still fails loud (kept — but trips both old and new checks)", async () => {
    const execution = new ScenarioExecution(
      {
        name: "realtime-user-text-proceed",
        description: "proceed() must not silently degrade a realtime user turn",
        agents: [new FakeVoiceAdapter(), new FakeRealtimeUserReturningText()],
      },
      [proceed(1)],
      "batch-test",
    );

    await expect(execution.execute()).rejects.toThrow(
      USER_TURN_NO_AUDIO_FOR_VOICE_AUT,
    );
  });

  it("Must-Fix 3: a voice user-sim returning TEXT is TTS'd to audio and does NOT throw", async () => {
    const execution = new ScenarioExecution(
      {
        name: "voice-sim-text-proceed",
        description: "a voice user-sim's generated text is voiced before broadcast",
        agents: [new FakeVoiceAdapter(), new VoiceSimReturningText()],
      },
      [proceed(1)],
      "batch-test",
    );

    await expect(execution.execute()).resolves.toBeDefined();
    // The generated TEXT turn was TTS'd to AUDIO before broadcast (the
    // regression this guards): the conversation history carries a user audio
    // turn, and the audio-presence invariant did NOT fire on the pre-TTS text.
    const userAudioTurns = execution.messages.filter(
      (m) => m.role === "user" && messageHasAudio(m),
    );
    expect(userAudioTurns.length).toBeGreaterThan(0);
  });

  it("does NOT fire on the scripted user() path (speakUserTurn — the supported route)", async () => {
    // Scripted user() routes through `speakUserTurn` (verbatim) — a different
    // method that produces audio and never reaches the proceed-path invariant.
    // The full scripted exchange must RESOLVE.
    const execution = new ScenarioExecution(
      {
        name: "realtime-user-scripted-ok",
        description: "scripted realtime-user turns are unaffected by the invariant",
        agents: [new FakeVoiceAdapter(), new FakeRealtimeUserReturningText()],
      },
      [user("Hi, I have a question about my account."), agent()],
      "batch-test",
    );

    await expect(execution.execute()).resolves.toBeDefined();
  });
});
