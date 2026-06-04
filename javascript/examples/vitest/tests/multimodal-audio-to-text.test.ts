import { openai } from "@ai-sdk/openai";
import scenario, {
  AgentAdapter,
  AgentInput,
  AgentRole,
} from "@langwatch/scenario";
import { UserModelMessage } from "ai";
import OpenAI from "openai";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";
import { describe, it, expect } from "vitest";
import {
  encodeAudioToBase64,
  getFixturePath,
  wrapJudgeForAudioTranscription,
} from "./helpers";
import { convertModelMessagesToOpenAIMessages } from "./helpers/convert-core-messages-to-openai";

// Skipped in CI: live end-to-end test — calls OpenAI's `gpt-audio-mini` audio
// model and the real LangWatch backend (cost, API keys, non-deterministic
// audio), so it runs live/locally rather than in CI. The skip historically
// also guarded the now-deleted `gpt-4o-audio-preview` (404 model_not_found
// since 2026-05-19); #607 swapped that dead model for `gpt-audio-mini`, so the
// model is no longer the blocker — the skip is CI-cost/live-only now.
const skipInCi = process.env.CI === "true";

class AudioAgent extends AgentAdapter {
  role: AgentRole = AgentRole.AGENT;
  private openai = new OpenAI();

  call = async (input: AgentInput) => {
    // To use the OpenAI "voice-to-voice" model, we need to use the
    // OpenAI api directly, and so we need to convert the messages to the correct
    // shape here.
    // @see https://platform.openai.com/docs/guides/audio?example=audio-in
    const messages = convertModelMessagesToOpenAIMessages(input.messages);
    const response = await this.respond(messages);

    // Scenario expects the response to be a string, so we only send the transcript
    const transcript = response.choices[0].message?.audio?.transcript;

    // Handle text response
    if (typeof transcript === "string") {
      return transcript;
    } else {
      throw new Error("Agent failed to generate a response");
    }
  };

  private async respond(messages: ChatCompletionMessageParam[]) {
    return await this.openai.chat.completions.create({
      model: "gpt-audio-mini",
      modalities: ["text", "audio"],
      audio: { voice: "alloy", format: "wav" },
      // We need to strip the id, or the openai client will throw an error
      messages,
      store: false,
    });
  }
}

// Use setId to group together for visualizing in the UI
const setId = "multimodal-audio-test";

/**
 * This example shows how to test an agent that can take audio input
 * and respond with text output.
 */
describe.skipIf(skipInCi)("Multimodal Audio to Text Tests", () => {
  it("should handle audio input", async () => {
    const data = encodeAudioToBase64(
      getFixturePath("male_or_female_voice.wav"),
    );

    // The AI-SDK will only support file parts,
    // so we cannot use the OpenAI shape from above
    // @see https://ai-sdk.dev/docs/foundations/prompts#file-parts
    const audioMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: `
          Answer the question in the audio.
          If you're not sure, you're required to take a best guess.
          After you've guessed, you must repeat the question and say what format the input was in (audio or text)
          `,
        },
        {
          type: "file",
          mediaType: "audio/wav",
          data,
        },
      ],
    } satisfies UserModelMessage;

    const audioJudge = wrapJudgeForAudioTranscription(
      scenario.judgeAgent({ model: openai("gpt-5") }),
    );

    const result = await scenario.run({
      name: "multimodal audio to text",
      description:
        "User sends audio file, agent analyzes and transcribes the content",
      agents: [new AudioAgent(), scenario.userSimulatorAgent(), audioJudge],
      script: [
        scenario.message(audioMessage),
        scenario.agent(),
        scenario.judge({
          criteria: [
            "The agent's response demonstrates it processed the audio content (e.g. it addresses what was in the audio, attempts to answer the audio question, or acknowledges what it heard)",
            "The agent provides a coherent, on-topic response — not an error message, refusal, or unrelated reply",
            "The agent's response indicates it received input in a non-text format, or that the question came via audio rather than text (exact phrasing does not matter)",
          ],
        }),
      ],
      setId,
    });

    try {
      expect(result.success).toBe(true);
    } catch (error) {
      console.error(result);
      throw error;
    }
  });

  // Ideas for future tests
  it.todo("should handle audio-only input without text");
  it.todo("should handle multiple audio formats (WAV, MP3)");
  it.todo("should handle long audio files gracefully");
  it.todo(
    "should provide appropriate responses for unclear or corrupted audio",
  );
  it.todo("should handle audio with background noise");
  it.todo("should transcribe speech in different languages");
  it.todo("should identify non-speech audio content (music, sounds, etc.)");
  it.todo("should handle multiple audio files in a single message");
  it.todo("should process audio with text instructions effectively");
});
