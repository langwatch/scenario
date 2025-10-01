/**
 * Judge Agent Audio Wrapper
 *
 * Wraps a judge agent to automatically transcribe audio messages to text
 * before evaluation. Required because judge agents can't process audio directly.
 */
import { AgentAdapter, AgentInput } from "@langwatch/scenario";
import { sanitizeMessagesForV5 } from "./sanitize-messages-for-v5";

/**
 * Wraps a judge agent to handle audio content in messages
 *
 * The wrapper:
 * - Intercepts the judge's call method
 * - Transcribes any audio content to text using Whisper
 * - Passes sanitized text-only messages to the judge
 *
 * @param judge - The judge agent to wrap
 * @returns The same judge instance with wrapped call method
 */
export function wrapJudgeForAudio<T extends AgentAdapter>(judge: T): T {
  const originalCall = judge.call.bind(judge);
  judge.call = async (input: AgentInput) => {
    const sanitizedInput = {
      ...input,
      messages: await sanitizeMessagesForV5(input.messages),
    };
    return originalCall(sanitizedInput);
  };
  return judge;
}
