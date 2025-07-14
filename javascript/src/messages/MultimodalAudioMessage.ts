import {
  ChatCompletionContentPartInputAudio,
  ChatCompletionContentPartText,
} from "openai/resources/chat/completions.mjs";
import { z } from "zod";

/**
 * Multimodal audio message content.
 *
 * We use the openai standard here for convenience,
 * but this might change in the future.
 */
type MultimodalAudioMessageContent = [
  ChatCompletionContentPartText,
  ChatCompletionContentPartInputAudio
];

// Zod schema for input validation
const MultimodalAudioMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.tuple([
    z.object({
      type: z.literal("text"),
      text: z.string(),
    }),
    z.object({
      type: z.literal("input_audio"),
      input_audio: z.object({
        data: z.string(),
        format: z.enum(["wav", "mp3"]),
      }),
    }),
  ]),
});

/**
 * Scenario multimodal audio message.
 *
 * This class should be used to standardize messages for Scenario implementations.
 *
 * Reasoning:
 * We don't want to be dependent on external library standards which might change
 * or be incompatible with other libraries.
 */
export class MultimodalAudioMessage {
  id?: string;
  role: "user" | "assistant";
  content: MultimodalAudioMessageContent;

  constructor(config: z.infer<typeof MultimodalAudioMessageSchema>) {
    // Validate input using zod schema
    const validatedConfig = MultimodalAudioMessageSchema.parse(config);

    this.role = validatedConfig.role;
    this.content = validatedConfig.content;
  }
}
