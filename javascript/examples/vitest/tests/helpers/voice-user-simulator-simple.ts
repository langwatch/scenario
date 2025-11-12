/**
 * Simple example: Voice-enabled user simulator
 *
 * This shows how easy it is to add voice capability by just overriding invokeLLM()
 */
import OpenAI from "openai";
import {
  UserSimulatorAgent,
  InvokeLLMInput,
  InvokeLLMResult,
  TestingAgentConfig,
} from "@langwatch/scenario";
import { CoreMessage } from "ai";

/**
 * Voice user simulator - extends UserSimulatorAgent and overrides just the LLM call
 */
export class VoiceUserSimulator extends UserSimulatorAgent {
  private openai = new OpenAI();
  private voice: "alloy" | "nova" | "echo" | "fable" | "onyx" | "shimmer";

  constructor(config: TestingAgentConfig & { voice?: string } = {}) {
    super(config);
    this.voice = (config.voice as any) ?? "nova";
  }

  /**
   * Override just the LLM invocation to use OpenAI voice API
   */
  protected async invokeLLM(input: InvokeLLMInput): Promise<InvokeLLMResult> {
    const response = await this.openai.chat.completions.create({
      model: "gpt-4o-audio-preview",
      messages: input.messages as any,
      modalities: ["text", "audio"],
      audio: { voice: this.voice, format: "wav" },
      store: false,
    });

    const audioData = response.choices[0].message?.audio?.data;
    const transcript = response.choices[0].message?.audio?.transcript;

    if (audioData) {
      // Return audio as multipart content
      return {
        content: [
          { type: "text", text: transcript || "" },
          { type: "file", mediaType: "audio/wav", data: audioData },
        ],
        completion: response,
      };
    }

    // Fallback to text if no audio
    return {
      content: transcript || "",
      completion: response,
    };
  }
}
