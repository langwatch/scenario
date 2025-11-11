import {
  AgentAdapter,
  AgentInput,
  AgentRole,
  ModelMessage,
} from "@langwatch/scenario";
import {
  OpenAIRealtimeWebSocket,
  RealtimeAgent,
  RealtimeSession,
} from "@openai/agents/realtime";
import { Buffer } from "buffer";

/**
 * Configuration options for RealtimeScenarioAdapter
 */
interface RealtimeScenarioAdapterConfig {
  /** System prompt for the agent */
  systemPrompt?: string;
  /** Voice for the agent */
  voice?: "alloy" | "nova" | "echo" | "fable" | "onyx" | "shimmer";
  /** Model to use */
  model?: string;
}

/**
 * Adapter that wraps OpenAI Realtime API for use in Scenario tests.
 * Converts turn-based audio messages to/from the streaming Realtime API.
 */
export class RealtimeScenarioAdapter extends AgentAdapter {
  role: AgentRole = AgentRole.AGENT;
  private config: RealtimeScenarioAdapterConfig;

  constructor(config?: RealtimeScenarioAdapterConfig) {
    super();
    this.config = {
      systemPrompt: "You are a helpful assistant. Be concise.",
      voice: "alloy",
      model: "gpt-4o-realtime-preview-2024-12-17",
      ...config,
    };
  }

  async call(input: AgentInput): Promise<ModelMessage> {
    const lastMessage = input.messages[input.messages.length - 1];
    const audioData = this.extractAudio(lastMessage);

    if (!audioData) {
      throw new Error(
        "No audio data found in the last message for RealtimeScenarioAdapter."
      );
    }

    const responseAudioBuffer = await this.getRealtimeResponse(audioData);

    // Convert ArrayBuffer to base64 string for ModelMessage
    const base64Audio = Buffer.from(responseAudioBuffer).toString("base64");

    return {
      role: "assistant",
      content: [
        { type: "text", text: "" },
        { type: "file", mediaType: "audio/pcm16", data: base64Audio },
      ],
    };
  }

  /**
   * Connects to OpenAI Realtime API, sends audio, and returns response audio
   */
  private async getRealtimeResponse(
    inputAudioBase64: string
  ): Promise<ArrayBuffer> {
    return new Promise(async (resolve, reject) => {
      const transport = new OpenAIRealtimeWebSocket({
        useInsecureApiKey: true,
      });

      const agent = new RealtimeAgent({
        name: "ScenarioAgent",
        instructions: this.config.systemPrompt,
        voice: this.config.voice,
      });

      const session = new RealtimeSession(agent, {
        transport,
        model: this.config.model,
      });

      let receivedAudioChunks: ArrayBuffer[] = [];

      // Listen for transport events
      transport.on("*", (event: any) => {
        if (event.type === "response.audio.delta" && event.delta) {
          receivedAudioChunks.push(event.delta);
        }

        if (event.type === "response.done" || event.type === "response.audio.done") {
          // Response is complete, combine audio chunks
          if (receivedAudioChunks.length > 0) {
            const totalLength = receivedAudioChunks.reduce(
              (sum, chunk) => sum + chunk.byteLength,
              0
            );
            const combinedBuffer = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of receivedAudioChunks) {
              combinedBuffer.set(new Uint8Array(chunk), offset);
              offset += chunk.byteLength;
            }
            session.disconnect();
            resolve(combinedBuffer.buffer);
          } else {
            session.disconnect();
            reject(new Error("No audio response received from Realtime API."));
          }
        }
      });

      transport.on("error", (error: any) => {
        session.disconnect();
        reject(new Error(`Transport error: ${error.message}`));
      });

      transport.on("close", () => {
        if (receivedAudioChunks.length === 0) {
          reject(new Error("Connection closed without receiving audio."));
        }
      });

      try {
        await session.connect({ apiKey: process.env.OPENAI_API_KEY! });

        // Convert base64 input audio to ArrayBuffer
        const binaryString = Buffer.from(inputAudioBase64, "base64").toString(
          "binary"
        );
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        // Send the audio
        session.sendAudio(bytes.buffer);
        
        // Signal end of input (commit the audio)
        session.sendAudio(new ArrayBuffer(0));
      } catch (error: any) {
        reject(new Error(`Failed to connect to Realtime API: ${error.message}`));
      }
    });
  }

  /**
   * Extracts audio data from a ModelMessage
   */
  private extractAudio(message: ModelMessage): string | null {
    if (!Array.isArray(message.content)) return null;

    const audioPart = message.content.find(
      (p): p is { type: "file"; mediaType: string; data: string } =>
        p.type === "file" && p.mediaType?.startsWith("audio/")
    );
    return audioPart?.data || null;
  }
}
