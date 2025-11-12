/**
 * Wraps a judge agent to handle audio messages
 *
 * This helper:
 * - Extracts text transcripts from audio messages
 * - Passes text-only messages to the judge
 * - Preserves original message structure for non-audio content
 *
 * The judge agent doesn't need to understand audio format, it just evaluates
 * the text transcripts.
 *
 * @example
 * ```typescript
 * const judge = wrapJudgeForAudio(
 *   scenario.judgeAgent({
 *     criteria: ["Should provide recipe"]
 *   })
 * );
 * ```
 */
import {
  AgentAdapter,
  AgentInput,
  type AgentReturnTypes,
} from "@langwatch/scenario";
import type { CoreMessage } from "ai";

/**
 * Wraps a judge agent to extract transcripts from audio messages before judging
 *
 * @param judge - The original judge agent
 * @returns Wrapped agent that handles audio messages
 */
export function wrapJudgeForAudio(judge: AgentAdapter): AgentAdapter {
  return {
    role: judge.role,

    async call(input: AgentInput): Promise<AgentReturnTypes> {
      // Extract transcripts from all audio messages
      const transcribedMessages = extractTranscriptsFromMessages(
        input.messages
      );

      // Call original judge with text-only messages
      return judge.call({
        ...input,
        messages: transcribedMessages,
      });
    },
  };
}

/**
 * Extracts text transcripts from audio messages
 *
 * For each message:
 * - If it has audio content, extract the text transcript
 * - Otherwise, keep the message as-is
 *
 * @param messages - Original messages (may contain audio)
 * @returns Messages with audio replaced by transcripts
 */
function extractTranscriptsFromMessages(
  messages: CoreMessage[]
): CoreMessage[] {
  return messages.map((msg) => {
    // Check if message has array content (may contain audio)
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

    // Return message as-is if no audio or already text
    return msg;
  });
}
