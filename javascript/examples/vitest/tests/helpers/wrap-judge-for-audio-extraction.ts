/**
 * Judge Agent Audio Extraction Wrapper
 *
 * Wraps a judge agent to extract text transcripts from audio messages
 * that already contain transcripts (e.g., from realtime conversations).
 *
 * Assumes transcripts are available in message content alongside audio data.
 *
 * @example
 * ```typescript
 * import { wrapJudgeForAudioExtraction } from "./helpers/wrap-judge-for-audio-extraction";
 *
 * const judge = wrapJudgeForAudioExtraction(
 *   scenario.judgeAgent({
 *     criteria: ["Should respond appropriately"]
 *   })
 * );
 * ```
 */
import {
  AgentAdapter,
  AgentInput,
  type AgentReturnTypes,
} from "@langwatch/scenario";
import type { ModelMessage } from "ai";

/**
 * Wraps a judge agent to extract transcripts from audio messages before judging
 *
 * For messages with audio content:
 * - Extracts text transcripts that are already present
 * - Preserves original message structure for non-audio content
 * - Passes text-only messages to the judge
 *
 * @param judge - The original judge agent
 * @returns Wrapped agent that handles audio messages with transcripts
 */
export function wrapJudgeForAudioExtraction(judge: AgentAdapter): AgentAdapter {
  return {
    role: judge.role,

    async call(input: AgentInput): Promise<AgentReturnTypes> {
      // Extract transcripts from all audio messages
      const transcribedMessages = extractTranscriptsFromMessages(input.messages);

      // Call original judge with text-only messages
      return judge.call({
        ...input,
        messages: transcribedMessages,
      });
    },
  };
}

/**
 * Extracts text transcripts from messages that may contain audio content
 *
 * For each message:
 * - If it has audio content with transcripts, extract the text
 * - Otherwise, keep the message as-is
 *
 * @param messages - Original messages (may contain audio with transcripts)
 * @returns Messages with audio content replaced by transcript text
 */
function extractTranscriptsFromMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    // Check if message has array content (may contain audio + transcripts)
    if (Array.isArray(msg.content)) {
      // Find text part (transcript)
      const textPart = msg.content.find((part) => part.type === "text");

      if (textPart && "text" in textPart) {
        // Return message with just the transcript
        return {
          ...msg,
          content: textPart.text,
        };
      }
    }

    // Return message as-is if no audio or already text-only
    return msg;
  });
}
