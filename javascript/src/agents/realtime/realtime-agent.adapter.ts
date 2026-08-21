/**
 * Realtime Agent Adapter for Scenario Testing
 *
 * Adapts a RealtimeSession to the Scenario framework interface. Create the
 * session with your own session creator, hand it to this adapter, then call
 * `connect()`.
 *
 * This ensures we test the REAL agent, not a mock, using the same session
 * creation pattern as the browser client. `connect()` mints the session
 * credential the same way `OpenAIRealtimeAgentAdapter` does, so a run pointed
 * at a LangWatch AI Gateway is metered there rather than dialing OpenAI with a
 * long-lived provider key.
 */

import { EventEmitter } from "events";
import type { RealtimeSession } from "@openai/agents/realtime";
import type { AssistantModelMessage } from "ai";
import { MessageProcessor } from "./message-processor";
import {
  RealtimeEventHandler,
  type AudioResponseEvent,
} from "./realtime-event-handler";
import { ResponseFormatter } from "./response-formatter";
import type { AgentInput, AgentReturnTypes, AgentRole } from "../../domain";
import { AgentAdapter } from "../../domain/agents";
import { Logger } from "../../utils/logger";
import {
  acquireRealtimeSocketKey,
  resolveRealtimeMintEndpoint,
  type RealtimeMintEndpoint,
} from "../../voice/broker";
import { OPENAI_REALTIME_MODEL } from "../../voice/voice-models";

/**
 * Configuration for RealtimeAgentAdapter
 */
export interface RealtimeAgentAdapterConfig {
  /**
   * The role of the agent
   */
  role: AgentRole;

  /**
   * A RealtimeSession instance
   *
   * The session should be created using your agent's session creator function.
   * Connect it through the adapter, which mints the session credential.
   *
   * @example
   * ```typescript
   * const session = createVegetarianRecipeSession();
   * const adapter = new RealtimeAgentAdapter({
   *   session,
   *   role: AgentRole.AGENT,
   *   agentName: "Vegetarian Recipe Assistant"
   * });
   * await adapter.connect();
   * ```
   */
  session: RealtimeSession;

  /**
   * Name of the agent (for logging/identification)
   */
  agentName: string;

  /**
   * Timeout for waiting for agent response (ms)
   * @default 30000
   */
  responseTimeout?: number;

  /**
   * Realtime model id the session credential is minted for.
   *
   * Read from the session's own options when omitted, and from
   * {@link OPENAI_REALTIME_MODEL} when the session names none. The gateway
   * prices and budgets the session against this value, so it has to match the
   * model the session actually opens with.
   */
  model?: string;

  /**
   * Where to mint the session credential, overriding `OPENAI_BASE_URL` and
   * `OPENAI_API_KEY`. `false` skips the mint and dials the vendor directly.
   *
   * Same option, same meaning and same default as
   * `OpenAIRealtimeAgentAdapterInit.mint`.
   */
  mint?: Partial<RealtimeMintEndpoint> | false;
}

/**
 * Adapter that connects Scenario testing framework to OpenAI Realtime API
 *
 * This adapter wraps a RealtimeSession to provide the Scenario framework
 * interface. The session is created by your own session creator, so the same
 * creation pattern runs in both browser and tests. `connect()` mints the
 * session credential at `OPENAI_BASE_URL`, which is how a run through a
 * LangWatch AI Gateway gets metered.
 *
 * @example
 * ```typescript
 * // In beforeAll
 * const session = createVegetarianRecipeSession();
 * const adapter = new RealtimeAgentAdapter({
 *   session,
 *   role: AgentRole.AGENT
 * });
 * await adapter.connect();
 *
 * // In test
 * await scenario.run({
 *   agents: [adapter, scenario.userSimulatorAgent()],
 *   script: [scenario.user("quick recipe"), scenario.agent()]
 * });
 *
 * // In afterAll
 * session.close();
 * ```
 */
export class RealtimeAgentAdapter extends AgentAdapter {
  role: AgentRole;
  name: string;

  private session: RealtimeSession;
  private eventHandler: RealtimeEventHandler;
  private messageProcessor = new MessageProcessor();
  private responseFormatter = new ResponseFormatter();
  private audioEvents = new EventEmitter();
  private readonly logger = new Logger("RealtimeAgentAdapter");
  /** The gateway's id for the current session, empty unless a gateway minted it. */
  private brokerSessionId = "";

  /**
   * Creates a new RealtimeAgentAdapter instance
   *
   * The session can be either connected or unconnected.
   * If unconnected, call connect() before use.
   *
   * @param config - Configuration for the realtime agent adapter
   */
  constructor(private config: RealtimeAgentAdapterConfig) {
    super();
    this.role = this.config.role;
    this.name = this.config.agentName;
    this.session = config.session;
    this.eventHandler = new RealtimeEventHandler(this.session);
  }

  /**
   * Whether the live session was minted by a gateway rather than the vendor.
   *
   * Only true after `connect()`, and only when the mint answered with
   * `X-LangWatch-Session-Id`. Configuration cannot set it, because the
   * response is the one thing that cannot be told a lie about what answered.
   */
  get brokered(): boolean {
    return this.brokerSessionId !== "";
  }

  /**
   * Open the session, minting its credential the way every other realtime
   * adapter does.
   *
   * The media websocket runs to OpenAI either way. What changes is the bearer
   * it opens with: `POST ${OPENAI_BASE_URL}/realtime/client_secrets` is
   * OpenAI's own mint path and a LangWatch AI Gateway mirrors it, so pointing
   * `OPENAI_BASE_URL` at a gateway makes the same request check the virtual
   * key's budget and session cap and open one spend record. The socket then
   * carries the ephemeral secret the mint returned, which the `@openai/agents`
   * websocket transport was built to take.
   *
   * An explicit `params.apiKey` skips the mint: the caller has already said
   * which credential to dial with.
   */
  async connect(
    params?: Parameters<RealtimeSession["connect"]>[0] | undefined
  ): Promise<void> {
    const { apiKey, ...rest } = params ?? {};
    this.brokerSessionId = "";
    if (apiKey) {
      await this.session.connect({ apiKey, ...rest });
      return;
    }

    // `OPENAI_REALTIME_API_KEY` is the direct-dial fallback, used only when the
    // base URL has no mint route. It is never offered to the mint, because a
    // gateway cannot bill a provider key it did not issue.
    const realtimeKey = process.env.OPENAI_REALTIME_API_KEY;
    const credential = await acquireRealtimeSocketKey(
      this.config.mint === false
        ? null
        : resolveRealtimeMintEndpoint(this.config.mint ?? undefined),
      {
        apiKey: realtimeKey ?? process.env.OPENAI_API_KEY ?? "",
        source:
          realtimeKey !== undefined
            ? "OPENAI_REALTIME_API_KEY"
            : "OPENAI_API_KEY",
      },
      {
        model: this.mintModel,
        noCredentialMessage:
          "RealtimeAgentAdapter.connect requires an API key: pass " +
          "params.apiKey, or set OPENAI_API_KEY so the session can be minted " +
          "at OPENAI_BASE_URL, or set OPENAI_REALTIME_API_KEY to dial OpenAI " +
          "directly.",
      },
    );
    this.brokerSessionId = credential.sessionId;

    await this.session.connect({
      apiKey: credential.socketKey,
      ...rest,
    });
  }

  /**
   * The model the mint is asked for.
   *
   * `RealtimeSession` keeps the model it was built with on its public
   * `options`, so a session created by the caller's own factory needs no
   * second declaration here.
   */
  private get mintModel(): string {
    const sessionModel = (
      this.session as RealtimeSession & { options?: { model?: string } }
    ).options?.model;
    return this.config.model ?? sessionModel ?? OPENAI_REALTIME_MODEL;
  }

  /**
   * Closes the session connection
   */
  async disconnect(): Promise<void> {
    this.session.close();
  }

  /**
   * Process input and generate response (implements AgentAdapter interface)
   *
   * This is called by Scenario framework for each agent turn.
   * Handles both text and audio input, returns audio message with transcript.
   *
   * @param input - Scenario agent input with message history
   * @returns Agent response as audio message or text
   */
  async call(input: AgentInput): Promise<AgentReturnTypes> {
    this.logger.debug(`[${this.name}] being called with role: ${this.role}`);

    const latestMessage = input.newMessages[input.newMessages.length - 1];

    if (!latestMessage) {
      return this.handleInitialResponse();
    }

    const audioData = this.messageProcessor.processAudioMessage(
      latestMessage.content
    );
    if (audioData) {
      return this.handleAudioInput(audioData);
    }

    const text = this.messageProcessor.extractTextMessage(
      latestMessage.content
    );
    if (!text) {
      throw new Error("Message has no text or audio content");
    }

    return this.handleTextInput(text);
  }

  /**
   * Handles the initial response when no user message exists
   */
  private async handleInitialResponse(): Promise<AssistantModelMessage> {
    this.logger.debug(`[${this.name}] First message, creating response`);

    const sessionWithTransport = this.session as RealtimeSession & {
      transport?: {
        sendEvent: (event: { type: string; [key: string]: unknown }) => void;
      };
    };

    const transport = sessionWithTransport.transport;
    if (!transport) {
      throw new Error("Realtime transport not available");
    }

    if (!this.eventHandler.isResponseActive()) {
      transport.sendEvent({
        type: "response.create",
      });
    }

    const timeout = this.config.responseTimeout ?? 60000;
    const response = await this.eventHandler.waitForResponse(timeout);

    // Emit audio response event
    this.audioEvents.emit("audioResponse", response);

    return this.responseFormatter.formatInitialResponse(response);
  }

  /**
   * Handles audio input from the user
   */
  private async handleAudioInput(
    audioData: string
  ): Promise<AssistantModelMessage> {
    const sessionWithTransport = this.session as RealtimeSession & {
      transport?: {
        sendEvent: (event: { type: string; [key: string]: unknown }) => void;
      };
    };

    const transport = sessionWithTransport.transport;
    if (!transport) {
      throw new Error("Realtime transport not available");
    }

    // Append audio to input buffer
    transport.sendEvent({
      type: "input_audio_buffer.append",
      audio: audioData,
    });

    // Commit the audio buffer
    transport.sendEvent({
      type: "input_audio_buffer.commit",
    });

    // Trigger response generation — guard against active-response race
    if (!this.eventHandler.isResponseActive()) {
      transport.sendEvent({
        type: "response.create",
      });
    }

    // Wait for audio response
    const timeout = this.config.responseTimeout ?? 60000;
    const response = await this.eventHandler.waitForResponse(timeout);

    // Emit audio response event
    this.audioEvents.emit("audioResponse", response);

    return this.responseFormatter.formatAudioResponse(response);
  }

  /**
   * Handles text input from the user
   */
  private async handleTextInput(text: string): Promise<string> {
    this.session.sendMessage(text);

    // Wait for response
    const timeout = this.config.responseTimeout ?? 30000;
    const response = await this.eventHandler.waitForResponse(timeout);

    // Emit audio response event (Realtime API always responds with audio, even for text input)
    this.audioEvents.emit("audioResponse", response);

    return this.responseFormatter.formatTextResponse(response.transcript);
  }

  /**
   * Subscribe to audio response events
   *
   * @param callback - Function called when an audio response completes
   */
  onAudioResponse(callback: (event: AudioResponseEvent) => void): void {
    this.audioEvents.on("audioResponse", callback);
  }

  /**
   * Remove audio response listener
   *
   * @param callback - The callback function to remove
   */
  offAudioResponse(callback: (event: AudioResponseEvent) => void): void {
    this.audioEvents.off("audioResponse", callback);
  }
}
