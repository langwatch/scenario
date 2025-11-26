/**
 * Judge Agent Audio Transcription Wrapper
 *
 * Wraps a judge agent to automatically transcribe audio files to text
 * before evaluation. Uses OpenAI Whisper API for transcription.
 *
 * Required because judge agents can't process audio directly.
 *
 * @example
 * ```typescript
 * import { wrapJudgeForAudioTranscription } from "./helpers/wrap-judge-for-audio-transcription";
 *
 * const judge = wrapJudgeForAudioTranscription(
 *   scenario.judgeAgent({
 *     criteria: ["Should provide recipe"]
 *   })
 * );
 * ```
 */
import { AgentAdapter, AgentInput } from "@langwatch/scenario";
import { sanitizeMessagesForV5 } from "./sanitize-messages-for-v5";

/**
 * Wraps a judge agent to handle audio file transcription before judging
 *
 * The wrapper:
 * - Intercepts the judge's call method
 * - Transcribes audio files using OpenAI Whisper (with caching)
 * - Passes text-only messages to the judge
 * - Gracefully handles transcription failures
 *
 * @param judge - The judge agent to wrap
 * @returns The same judge instance with wrapped call method
 */
export function wrapJudgeForAudioTranscription<T extends AgentAdapter>(judge: T): T {
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
