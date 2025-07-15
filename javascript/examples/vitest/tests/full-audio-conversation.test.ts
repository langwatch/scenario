import scenario, {
  AgentAdapter,
  AgentInput,
  AgentRole,
} from "@langwatch/scenario";
import { describe, it, expect } from "vitest";
import OpenAI from "openai";
import { openai } from "@ai-sdk/openai";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";
import { CoreUserMessage, CoreAssistantMessage, CoreMessage } from "ai";
import { convertCoreMessagesToOpenAIMessages } from "./helpers/convert-core-messages-to-openai";

/**
 * Abstract base class for voice-enabled agents using OpenAI's voice-to-voice model
 * Handles common audio generation and response processing logic
 */
abstract class VoiceAgent extends AgentAdapter {
  private openai = new OpenAI();

  constructor(
    private systemPrompt: string,
    private voice: "alloy" | "nova" | "echo" | "fable" | "onyx" | "shimmer"
  ) {
    super();
  }

  call = async (input: AgentInput): Promise<CoreMessage | string> => {
    try {
      // Convert messages to OpenAI format for voice-to-voice model
      const messages = convertCoreMessagesToOpenAIMessages(input.messages);

      // Add system prompt
      const systemMessage: ChatCompletionMessageParam = {
        role: "system",
        content: this.systemPrompt,
      };

      const response = await this.openai.chat.completions.create({
        model: "gpt-4o-audio-preview",
        modalities: ["text", "audio"],
        audio: { voice: this.voice, format: "wav" },
        messages: [systemMessage, ...messages],
        store: false,
      });

      // Extract audio data and transcript
      const audioData = response.choices[0].message?.audio?.data;
      const transcript = response.choices[0].message?.audio?.transcript;

      if (audioData) {
        console.log(`${this.constructor.name} AUDIO RESPONSE`, transcript);
        return this.createAudioResponse(audioData);
      } else if (transcript) {
        console.log(`${this.constructor.name} TEXT FALLBACK`, transcript);
        return transcript;
      } else {
        throw new Error(
          `${this.constructor.name} failed to generate a response`
        );
      }
    } catch (error) {
      console.error(
        `${this.constructor.name} failed to generate a response`,
        error,
        input.messages
      );
      throw error;
    }
  };

  /**
   * Creates the appropriate audio response based on the agent's role
   * Must be implemented by subclasses to return the correct message type
   */
  protected abstract createAudioResponse(audioData: string): CoreMessage;
}

/**
 * Audio agent that responds with audio using OpenAI's voice-to-voice model
 */
class MyAgent extends VoiceAgent {
  role: AgentRole = AgentRole.AGENT;

  constructor() {
    super(
      `You are a helpful and engaging AI assistant.
      Respond naturally and conversationally since this is an audio conversation.
      Be informative but keep your responses concise and engaging.
      Adapt your speaking style to be natural for audio.`,
      "alloy"
    );
  }

  protected createAudioResponse(audioData: string): CoreAssistantMessage {
    return {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "",
        },
        {
          type: "file",
          mimeType: "audio/wav",
          data: audioData,
        },
      ],
    } as CoreAssistantMessage;
  }
}

/**
 * Custom user simulation agent that generates audio responses
 * for full audio-to-audio conversations
 */
class AudioUserSimulatorAgent extends VoiceAgent {
  role: AgentRole = AgentRole.USER;

  constructor() {
    super(
      `You are a curious user having a conversation.
      Ask follow-up questions, show interest in the responses, and keep the conversation engaging.
      Be natural and conversational in your speech patterns.
      This is an audio conversation, so speak as you would naturally talk.
      Keep your responses concise but engaging.`,
      "nova"
    );
  }

  protected createAudioResponse(audioData: string): CoreUserMessage {
    return {
      role: "user",
      content: [
        {
          type: "text",
          text: "",
        },
        {
          type: "file",
          mimeType: "audio/wav",
          data: audioData,
        },
      ],
    } as CoreUserMessage;
  }
}

// /**
//  * Generates an initial audio message to start the conversation
//  * This simulates a user asking a question in audio format
//  */
// async function generateInitialAudioMessage(): Promise<CoreUserMessage> {
//   const openai = new OpenAI();

//   // Generate audio for an initial question
//   const response = await openai.chat.completions.create({
//     model: "gpt-4o-audio-preview",
//     modalities: ["text", "audio"],
//     audio: { voice: "nova", format: "wav" },
//     messages: [
//       {
//         role: "system",
//         content:
//           "You are starting a conversation. Ask an interesting question about a topic you're curious about. Keep it natural and conversational.",
//       },
//       {
//         role: "user",
//         content:
//           "Hi there! I'd love to learn something new today. Could you tell me about something fascinating?",
//       },
//     ],
//     store: false,
//   });

//   const audioData = response.choices[0].message?.audio?.data;
//   const transcript = response.choices[0].message?.audio?.transcript;

//   if (audioData) {
//     console.log("INITIAL AUDIO MESSAGE", transcript);
//     return {
//       role: "user",
//       content: [
//         {
//           type: "file",
//           mimeType: "audio/wav",
//           data: audioData,
//         },
//       ],
//     } as CoreUserMessage;
//   } else {
//     // Fallback to text if audio generation fails
//     return {
//       role: "user",
//       content:
//         "Hi there! I'd love to learn something new today. Could you tell me about something fascinating?",
//     } as CoreUserMessage;
//   }
// }

// Use setId to group together for visualizing in the UI
const setId = "full-audio-conversation-test";

describe("Full Audio-to-Audio Conversation Tests", () => {
  it.only("should handle complete audio-to-audio conversation", async () => {
    const audioUserSimulator = new AudioUserSimulatorAgent();
    const audioAgent = new MyAgent();

    // Judge that can evaluate audio conversations
    const conversationJudge = scenario.judgeAgent({
      model: openai("gpt-4o-audio-preview"),
      criteria: ["The conversation flows naturally between user and agent"],
    });

    // Initial audio message to start the conversation
    // const initialAudioMessage = await generateInitialAudioMessage();

    const result = await scenario.run({
      name: "full audio-to-audio conversation",
      description:
        "Complete audio conversation between user simulator and agent over multiple turns",
      agents: [audioAgent, audioUserSimulator, conversationJudge],
      script: [
        scenario.user(
          "Hi there! I'd love to learn something new today. Could you tell me about something fascinating?"
        ), // User simulator follows up
        scenario.agent(), // Agent responds to initial message
        scenario.user(), // User simulator follows up
        scenario.agent(), // Agent responds again
        scenario.user(), // User simulator continues
        scenario.agent(), // Final agent response
        scenario.judge(), // Judge evaluates the entire conversation
      ],
      setId,
    });

    try {
      console.log("FULL AUDIO CONVERSATION RESULT", result);
      expect(result.success).toBe(true);
    } catch (error) {
      console.error("Full audio conversation failed:", result);
      throw error;
    }
  });

  it("should handle longer audio conversations", async () => {
    const audioUserSimulator = new AudioUserSimulatorAgent();
    const audioAgent = new MyAgent();

    // Judge for longer conversations
    const extendedConversationJudge = scenario.judgeAgent({
      model: openai("gpt-4o-audio-preview"),
      criteria: [
        "The conversation maintains coherence over multiple turns",
        "Both parties stay on topic while allowing natural flow",
        "The agent remembers context from earlier in the conversation",
        "The user simulator builds on previous responses appropriately",
        "The conversation reaches a natural conclusion",
      ],
    });

    // Initial audio message about a complex topic
    const complexInitialMessage: CoreUserMessage = {
      role: "user",
      content:
        "I'm planning a career change and would love to discuss the pros and cons of different approaches. What should I consider?",
    };

    const result = await scenario.run({
      name: "extended audio conversation",
      description:
        "Longer audio conversation testing context retention and natural flow",
      agents: [audioAgent, audioUserSimulator, extendedConversationJudge],
      script: [
        scenario.message(complexInitialMessage),
        scenario.agent(),
        scenario.user(),
        scenario.agent(),
        scenario.user(),
        scenario.agent(),
        scenario.user(),
        scenario.agent(),
        scenario.judge(),
      ],
      setId,
    });

    try {
      console.log("EXTENDED AUDIO CONVERSATION RESULT", result);
      expect(result.success).toBe(true);
    } catch (error) {
      console.error("Extended audio conversation failed:", result);
      throw error;
    }
  });

  it.todo("should handle audio conversation with emotional content");
  it.todo("should handle audio conversation with technical topics");
  it.todo("should handle audio conversation interruptions gracefully");
  it.todo("should handle audio conversation with multiple speakers");
});
