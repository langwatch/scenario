import {
  AgentRole,
  type AgentInput,
  type AgentReturnTypes,
  UserSimulatorAgentAdapter,
} from "../../../domain";
import type { AudioChunk } from "../../audio-chunk";

/**
 * Build a user-role message carrying an audio (`input_audio` / pcm16) content
 * block from a chunk's bytes.
 *
 * Cast through unknown: the audio shape is locally typed as `AudioMessageParam`
 * but the executor's `ModelMessage` union accepts assistant arrays only.
 * `ConvertModelMessagesToAguiMessages` JSON-stringifies the content, so the
 * audio survives downstream.
 */
export function audioMessageContent(chunk: AudioChunk): AgentReturnTypes {
  const base64 = Buffer.from(chunk.data).toString("base64");
  return {
    role: "user",
    content: [
      {
        type: "input_audio",
        input_audio: { data: base64, format: "pcm16" },
      },
    ],
  } as unknown as AgentReturnTypes;
}

/**
 * User simulator that returns an audio-shaped message so the default voice
 * `call()` actually flows bytes through `sendAudio`. Without this, the user
 * turn arrives as text and `extractAudioFromLastMessage` yields null, so no
 * user-side audio hook fires.
 */
export class AudioUserSimulator extends UserSimulatorAgentAdapter {
  role = AgentRole.USER;
  constructor(private readonly chunk: AudioChunk) {
    super();
  }
  async call(_input: AgentInput): Promise<AgentReturnTypes> {
    return audioMessageContent(this.chunk);
  }
}
