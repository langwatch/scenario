/**
 * RealtimeScenarioAdapter - Bridges OpenAI Realtime API to Scenario testing
 *
 * Uses the OpenAI Agents SDK transport layer for clean, maintainable code.
 * Follows SRP: just adapts realtime streaming to turn-based testing.
 *
 * @example
 * ```typescript
 * const agent = new RealtimeScenarioAdapter({
 *   name: 'Assistant',
 *   instructions: 'Be helpful and concise',
 *   voice: 'alloy'
 * });
 *
 * await scenario.run({
 *   agents: [userSimulator, agent, judge],
 *   script: [scenario.proceed(3), scenario.judge()]
 * });
 * ```
 */
import { AgentAdapter, AgentInput, AgentRole } from "@langwatch/scenario";
import { ModelMessage } from "ai";
import {
  OpenAIRealtimeWebSocket,
  type RealtimeAgentConfiguration,
} from "@openai/agents/realtime";

/**
 * Configuration for RealtimeScenarioAdapter
 */
export interface RealtimeScenarioConfig
  extends Partial<RealtimeAgentConfiguration> {
  /** OpenAI model to use */
  model?: string;
}

/**
 * Adapter that uses OpenAI Realtime API for Scenario testing
 *
 * Responsibilities:
 * - Extract audio from input messages
 * - Send to OpenAI Realtime API via transport layer
 * - Buffer streaming response into complete turn
 * - Return formatted audio message
 */
export class RealtimeScenarioAdapter extends AgentAdapter {
  role: AgentRole = AgentRole.AGENT;
  private config: RealtimeScenarioConfig;

  constructor(config: RealtimeScenarioConfig = {}) {
    super();
    this.config = {
      name: config.name || "RealtimeAgent",
      instructions:
        config.instructions || "Be helpful and respond concisely.",
      voice: config.voice || "alloy",
      model: config.model || "gpt-4o-realtime-preview-2024-12-17",
      ...config,
    };
  }

  /**
   * Process audio input and return complete audio response
   */
  async call(input: AgentInput): Promise<ModelMessage> {
    const lastMessage = input.messages[input.messages.length - 1];

    // Extract audio from message
    const audioData = this.extractAudio(lastMessage);
    if (!audioData) {
      throw new Error(
        "RealtimeScenarioAdapter requires audio input. No audio found in last message."
      );
    }

    console.log(
      `${this.config.name}: Processing audio (${audioData.length} chars base64)`
    );

    // Get complete response from Realtime API
    const { audio, transcript } = await this.getRealtimeResponse(audioData);

    console.log(`${this.config.name}: "${transcript}"`);

    // Return as audio message
    return {
      role: "assistant",
      content: [
        { type: "text", text: transcript || "" },
        { type: "file", mediaType: "audio/pcm16", data: audio },
      ],
    };
  }

  /**
   * Send audio to Realtime API and collect complete response
   * Uses OpenAI Agents SDK transport layer
   */
  private async getRealtimeResponse(
    inputAudioBase64: string
  ): Promise<{ audio: string; transcript: string }> {
    return new Promise(async (resolve, reject) => {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        reject(new Error("OPENAI_API_KEY environment variable not set"));
        return;
      }

      // Create transport using SDK
      const transport = new OpenAIRealtimeWebSocket();

      let audioChunks: string[] = [];
      let transcript = "";

      const timeout = setTimeout(() => {
        transport.disconnect();
        reject(new Error("Realtime API timeout (30s)"));
      }, 30000);

      try {
        // Listen for audio chunks
        transport.on("audio", (event: any) => {
          if (event.data) {
            audioChunks.push(event.data);
          }
        });

        // Listen for transcript
        transport.on("transcript", (event: any) => {
          if (event.text) {
            transcript += event.text;
          }
        });

        // Listen for response completion
        transport.on("response_completed", () => {
          clearTimeout(timeout);
          transport.disconnect();
          resolve({
            audio: audioChunks.join(""),
            transcript,
          });
        });

        // Listen for errors
        transport.on("error", (error: any) => {
          clearTimeout(timeout);
          transport.disconnect();
          reject(new Error(`Transport error: ${error.message || error}`));
        });

        // Connect with config
        await transport.connect({
          apiKey,
          model: this.config.model!,
          initialSessionConfig: {
            instructions: this.config.instructions,
            voice: this.config.voice,
            modalities: ["audio", "text"],
            inputAudioFormat: "pcm16",
            outputAudioFormat: "pcm16",
          },
        });

        // Send audio
        transport.sendAudio(Buffer.from(inputAudioBase64, "base64"));

        // Trigger response generation
        transport.sendEvent({
          type: "response.create",
        });
      } catch (error) {
        clearTimeout(timeout);
        if (transport) {
          transport.disconnect();
        }
        reject(error);
      }
    });
  }

  /**
   * Extract audio data from a message
   */
  private extractAudio(message: any): string | null {
    if (typeof message.content === "string") return null;

    const content = Array.isArray(message.content) ? message.content : [];
    const audioPart = content.find(
      (p: any) => p.type === "file" && p.mediaType?.includes("audio")
    );

    return audioPart?.data || null;
  }
}

