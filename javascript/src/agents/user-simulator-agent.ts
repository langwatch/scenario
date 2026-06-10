import { ModelMessage } from "ai";

import { createLLMInvoker } from "./llm-invoker.factory";
import { TestingAgentConfig, InvokeLLMParams, InvokeLLMResult } from "./types";
import { messageRoleReversal } from "./utils";
import { getProjectConfig } from "../config";
import { AgentInput, UserSimulatorAgentAdapter } from "../domain";
import { modelSchema } from "../domain/core/schemas/model.schema";
import { Logger } from "../utils/logger";
import { AudioChunk } from "../voice/audio-chunk";
import { createAudioMessage } from "../voice/messages";
import { synthesize } from "../voice/tts";

/**
 * Configuration for the voice path of the user simulator (§4.2).
 *
 * When `voice` is set, the simulator runs TTS on each generated text turn and
 * emits an {@link AudioMessageParam} instead of a plain text message.
 */
export interface UserSimulatorVoiceConfig {
  /**
   * TTS voice identifier in `provider/voice_name` format, e.g. `"openai/nova"`.
   * When present, each simulator turn is synthesized to audio via this voice.
   */
  voice?: string;

  /**
   * Optional persona description appended to the system prompt.
   * Shapes the text content of the simulated user.
   */
  persona?: string;

  /**
   * Optional array of audio effect functions applied to each synthesized audio
   * turn AFTER the TTS cache hit (effects are never baked into the cache key).
   * Each function receives the raw PCM16 bytes and returns transformed bytes.
   */
  audioEffects?: Array<(audio: Uint8Array) => Uint8Array>;

  /**
   * Probability in [0, 1] that the simulator interrupts each agent turn during
   * `proceed()` (PRD §4.2 `interrupt_probability=0.3`). The executor reads this
   * inside the proceed loop and fires a barge-in per the configured chance.
   * Unset/0 = never interrupt.
   */
  interruptProbability?: number;
}

/**
 * Combined configuration for the user simulator agent, merging LLM config
 * with optional voice configuration.
 */
export interface UserSimulatorAgentConfig
  extends TestingAgentConfig,
    UserSimulatorVoiceConfig {}

function buildSystemPrompt(description: string, persona?: string): string {
  const personaBlock = persona
    ? `\n\n<persona>\n${persona}\n</persona>\n`
    : "";

  return `
<role>
You are pretending to be a user, you are testing an AI Agent (shown as the user role) based on a scenario.
Approach this naturally, as a human user would, with very short inputs, few words, all lowercase, imperative, not periods, like when they google or talk to chatgpt.
</role>

<goal>
Your goal (assistant) is to interact with the Agent Under Test (user) as if you were a human user to see if it can complete the scenario successfully.
</goal>

<scenario>
${description}
</scenario>

<rules>
- DO NOT carry over any requests yourself, YOU ARE NOT the assistant today, you are the user
</rules>
${personaBlock}`.trim();
}

/**
 * Remove audio content blocks from messages before sending to a text-only LLM.
 *
 * Voice turns carry the canonical AI-SDK audio `file` part (`{ type: "file",
 * mediaType: "audio/pcm16", … }`, see `voice/messages.ts`) which text-only
 * models like `gpt-4.1-mini` reject. This helper keeps `text` parts as-is and
 * replaces audio-only messages with an `[audio message]` placeholder so the
 * LLM still has a structural turn in the right position.
 *
 * Port of `python/scenario/user_simulator_agent.py:_strip_audio_content`.
 */
function stripAudioContent(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    const content = msg.content;
    if (!Array.isArray(content)) return msg;

    const parts = content as Array<Record<string, unknown>>;
    const textParts = parts
      .filter((p) => p?.type === "text" && typeof p["text"] === "string")
      .map((p) => p["text"] as string);

    if (textParts.length > 0) {
      return { ...msg, content: textParts.join(" ") } as ModelMessage;
    }
    return { ...msg, content: "[audio message]" } as ModelMessage;
  });
}

class UserSimulatorAgent extends UserSimulatorAgentAdapter {
  private logger = new Logger(this.constructor.name);

  /**
   * LLM invocation function. Can be overridden to customize LLM behavior.
   */
  invokeLLM: (params: InvokeLLMParams) => Promise<InvokeLLMResult> =
    createLLMInvoker(this.logger);

  /**
   * Synthesize TTS audio. Exposed as a property so tests can replace it with
   * a stub without subclassing.
   *
   * Signature mirrors `python/scenario/voice/tts.py:synthesize(text, voice)`.
   * Returns an {@link AudioChunk} with the synthesized PCM16 data.
   *
   * Default: routes through the per-run TTS module (`voice/tts#synthesize`),
   * whose `"provider/voice"` router resolves the backend and whose LRU cache
   * is keyed on `(sha256(text), voice)` — effects apply AFTER the cache read
   * (in {@link voiceify}), never baked into the key. Per-run, not a module
   * global. Tests inject a stub via `_synthesize`.
   */
  _synthesize: (text: string, voice: string) => Promise<AudioChunk> = (
    text,
    voice,
  ) => synthesize(text, voice);

  // ---------------------------------------------- per-step overrides (§4.2)
  // Mirror of python/scenario/user_simulator_agent.py _one_shot_override.
  // The executor installs a single-turn override (voice_style or audio_effects)
  // that is cleared after the turn so subsequent turns revert to defaults.

  _voiceStyleOverride: string | null = null;
  _audioEffectsOverride: Array<(audio: Uint8Array) => Uint8Array> | null = null;

  /** Class-level one-shot warning flag (mirrors Python's class attribute). */
  private static _voiceStyleWarningEmitted = false;

  constructor(private readonly cfg?: UserSimulatorAgentConfig) {
    super();
  }

  /**
   * Per-sim interruption probability (PRD §4.2 `interrupt_probability`). The
   * executor reads this during `proceed()` to decide whether to barge in on a
   * given agent turn. Defaults to 0 (never).
   */
  get interruptProbability(): number {
    return this.cfg?.interruptProbability ?? 0;
  }

  /**
   * Returns the effective audio effects for this turn:
   * per-step override if set, otherwise the configured defaults.
   */
  private effectiveAudioEffects(): Array<(audio: Uint8Array) => Uint8Array> {
    if (this._audioEffectsOverride !== null) {
      return [...this._audioEffectsOverride];
    }
    return [...(this.cfg?.audioEffects ?? [])];
  }

  /**
   * Emit a one-shot UserWarning if voice_style was passed (not yet wired).
   */
  private warnVoiceStyleOnce(): void {
    if (UserSimulatorAgent._voiceStyleWarningEmitted) return;
    UserSimulatorAgent._voiceStyleWarningEmitted = true;
    // Node doesn't have a process.emitWarning parity issue — warn to console.
    console.warn(
      "UserSimulatorAgent: voice_style=... is accepted for forward " +
        "compatibility but no TTS provider currently honours it. The " +
        "simulator will synthesise without style modification. This will land " +
        "as a per-provider instructions channel in a follow-up."
    );
  }

  /**
   * Set a per-step override for voice_style and/or audio_effects.
   * Returns a cleanup function that restores the previous overrides.
   *
   * Usage:
   * ```ts
   * const restore = sim.setOneShotOverride({ voiceStyle: "angry" });
   * try { await sim.call(input); } finally { restore(); }
   * ```
   */
  setOneShotOverride(opts: {
    voiceStyle?: string;
    audioEffects?: Array<(audio: Uint8Array) => Uint8Array>;
  }): () => void {
    const prevStyle = this._voiceStyleOverride;
    const prevEffects = this._audioEffectsOverride;
    this._voiceStyleOverride =
      opts.voiceStyle !== undefined ? opts.voiceStyle : null;
    this._audioEffectsOverride =
      opts.audioEffects !== undefined ? opts.audioEffects : null;

    return () => {
      this._voiceStyleOverride = prevStyle;
      this._audioEffectsOverride = prevEffects;
    };
  }

  /**
   * The simulator's own configured TTS voice (PRD §4.2,
   * `userSimulatorAgent({ voice })`), or `undefined` when none was set.
   *
   * Exposed (mirrors Python's `UserSimulatorAgent.voice` attribute) so the
   * executor can decide whether a scripted `user("text")` step should be
   * voiceified for a voice agent under test — see
   * `scenario_executor.py:_find_user_sim` + the `getattr(sim, "voice", None)`
   * guard.
   */
  get voice(): string | undefined {
    return this.cfg?.voice;
  }

  /**
   * Resolve the effective TTS voice for this turn (per-run).
   *
   * Priority: the simulator's own `voice` (PRD §4.2,
   * `userSimulatorAgent({ voice })`) wins; otherwise the per-run
   * `cfg.voice.tts.voice` carried on `ScenarioConfig.voice` (`run({ voice:
   * { tts: { voice } } })`). Both are per-run sources — no module global.
   */
  private effectiveVoice(input: AgentInput): string | undefined {
    return this.cfg?.voice ?? input.scenarioConfig.voice?.tts?.voice;
  }

  /**
   * Voiceify an explicit, scripted user line (`scenario.user("text")`) into an
   * audio {@link ModelMessage} — TTS via the effective voice + any active
   * per-step effects/overrides. Returns the original text message unchanged
   * when no voice resolves or the content is empty.
   *
   * Port of the explicit-content branch of
   * `python/scenario/scenario_executor.py:user` (`sim._voiceify({...})`). The
   * auto-generated-turn path uses the private {@link voiceify} (which also
   * reads the per-run `cfg.voice.tts.voice` off `AgentInput`); this entry
   * point is for the executor's scripted-content path, where the simulator's
   * OWN `voice` is authoritative and the per-run config is supplied directly.
   */
  async voiceifyText(
    text: string,
    runVoiceConfig?: { tts?: { voice?: string } },
  ): Promise<ModelMessage> {
    const voice = this.cfg?.voice ?? runVoiceConfig?.tts?.voice;
    const textMessage: ModelMessage = { role: "user", content: text };
    if (!voice || !text) return textMessage;
    return this.synthesizeToAudioMessage(text, voice);
  }

  /**
   * Convert a text user message into an audio message via TTS + effects.
   * Port of `python/scenario/user_simulator_agent.py:_voiceify`.
   */
  private async voiceify(
    textMessage: ModelMessage,
    input: AgentInput,
  ): Promise<ModelMessage> {
    const voice = this.effectiveVoice(input);
    if (!voice) return textMessage;

    const content =
      typeof textMessage.content === "string" ? textMessage.content : "";
    if (!content) return textMessage;

    return this.synthesizeToAudioMessage(content, voice);
  }

  /**
   * Shared TTS pipeline behind {@link voiceifyText} (scripted content) and
   * {@link voiceify} (auto-generated turns): synthesize `text` with `voice`,
   * apply any active one-shot warning + audio effects, and wrap the result in
   * the canonical audio {@link ModelMessage}. Callers own the
   * "should this turn be voiced?" decision (voice/empty-content guards) so
   * this stays a pure text→audio-message transform.
   */
  private async synthesizeToAudioMessage(
    text: string,
    voice: string,
  ): Promise<ModelMessage> {
    if (this._voiceStyleOverride !== null) {
      this.warnVoiceStyleOnce();
    }

    const chunk = await this._synthesize(text, voice);
    let audioBytes = chunk.data;
    const effects = this.effectiveAudioEffects();
    for (const effect of effects) {
      audioBytes = effect(audioBytes);
    }
    const finalChunk = new AudioChunk({ data: audioBytes, transcript: text });
    // createAudioMessage already returns AudioMessage (= ModelMessage); no cast.
    return createAudioMessage(finalChunk, "user");
  }

  call = async (input: AgentInput): Promise<ModelMessage> => {
    const config = this.cfg;
    const persona = config?.persona;

    const systemPrompt =
      config?.systemPrompt ?? buildSystemPrompt(input.scenarioConfig.description, persona);

    // Strip audio content from messages before sending to text LLM (§4.2 — the
    // LLM that generates text is always text-only; audio is synthesized separately).
    const strippedMessages = stripAudioContent(input.messages);

    const messages: ModelMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "assistant", content: "Hello, how can I help you today" },
      ...strippedMessages,
    ];

    const projectConfig = await getProjectConfig();
    // Merge the agent config with the project config and validate
    const mergedConfig = modelSchema.parse({
      ...projectConfig?.defaultModel,
      ...config,
    });

    // User to assistant role reversal (mirrors Python's role reversal to avoid LLM bias).
    const reversedMessages = messageRoleReversal(messages);

    const completion = await this.invokeLLM({
      model: mergedConfig.model,
      messages: reversedMessages,
      temperature: mergedConfig.temperature,
      maxOutputTokens: mergedConfig.maxTokens,
    });

    const messageContent = completion.text;
    if (!messageContent) {
      throw new Error("No response content from LLM");
    }

    const textMessage = {
      role: "user",
      content: messageContent,
    } satisfies ModelMessage;

    // If voice is configured — either on the simulator (PRD §4.2 `voice`) or
    // per-run via `cfg.voice.tts` — run TTS and return an audio message.
    if (this.effectiveVoice(input)) {
      return this.voiceify(textMessage, input);
    }

    return textMessage;
  };
}

/**
 * Agent that simulates realistic user behavior in scenario conversations.
 *
 * This agent generates user messages that are appropriate for the given scenario
 * context, simulating how a real human user would interact with the agent under test.
 * It uses an LLM to generate natural, contextually relevant user inputs that help
 * drive the conversation forward according to the scenario description.
 *
 * @param config Optional configuration for the agent.
 * @param config.model The language model to use for generating responses.
 *                     If not provided, a default model will be used.
 * @param config.temperature Optional temperature for the language model (0.0-1.0).
 *                          Lower values make responses more deterministic.
 *                          Omitted by default for compatibility with reasoning models.
 * @param config.maxTokens The maximum number of tokens to generate.
 *                        If not provided, uses model defaults.
 * @param config.name The name of the agent.
 * @param config.systemPrompt Custom system prompt to override default user simulation behavior.
 *                           Use this to create specialized user personas or behaviors.
 * @param config.voice TTS voice identifier in `provider/voice_name` format (e.g. `"openai/nova"`).
 *                    When set, each simulator turn is synthesized to audio.
 * @param config.persona Optional persona description appended to the system prompt.
 * @param config.audioEffects Optional audio effect functions applied after TTS synthesis.
 *
 * @throws {Error} If no model is configured either in parameters or global config.
 *
 * @example
 * ```typescript
 * import { run, userSimulatorAgent, AgentRole, user, agent, AgentAdapter } from '@langwatch/scenario';
 *
 * const myAgent: AgentAdapter = {
 *   role: AgentRole.AGENT,
 *   async call(input) {
 *     return `The user said: ${input.messages.at(-1)?.content}`;
 *   }
 * };
 *
 * async function main() {
 *   // Basic user simulator with default behavior
 *   const basicResult = await run({
 *     name: "User Simulator Test",
 *     description: "A simple test to see if the user simulator works.",
 *     agents: [myAgent, userSimulatorAgent()],
 *     script: [
 *       user(),
 *       agent(),
 *     ],
 *   });
 *
 *   // Voice-enabled user simulator
 *   const voiceResult = await run({
 *     name: "Voice User Simulator Test",
 *     description: "Test voice user simulation",
 *     agents: [
 *       myAgent,
 *       userSimulatorAgent({
 *         voice: "openai/nova",
 *         persona: "An elderly customer confused by technology",
 *         audioEffects: [],
 *       })
 *     ],
 *     script: [user(), agent()],
 *   });
 * }
 * main();
 * ```
 *
 * **Implementation Notes:**
 * - Uses role reversal internally to work around LLM biases toward assistant roles
 * - Audio content is stripped from messages sent to the text LLM
 * - TTS synthesis is applied AFTER the LLM generates text (cache key = (text, voice))
 * - Audio effects are applied AFTER any TTS cache hit (effects never enter the cache)
 */
export const userSimulatorAgent = (config?: UserSimulatorAgentConfig) => {
  return new UserSimulatorAgent(config);
};

export type { UserSimulatorAgent };
