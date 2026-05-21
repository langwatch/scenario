/**
 * Audio message type surface (Decision 2(b) — see issue #372).
 *
 * Python `python/scenario/voice/messages.py:17` imports
 * `ChatCompletionMessageParam` from `openai.types.chat` at module load,
 * committing the canonical message bus to OpenAI's schema. The TS port
 * locks Decision 2(b): define a local {@link AudioMessageParam} superset
 * that is structurally compatible with OpenAI's shape but does NOT import
 * from `openai`.
 *
 * Rationale (from the locked AC at `specs/voice-agents.feature:819-824`):
 * audio works cleanly in any message role — user, assistant, or tool — so
 * the type bus must not bake in OpenAI's awkward assistant-role split that
 * led to the JS `forceUserRole` workaround we are NOT porting.
 *
 * NOTE: this file MUST NOT import from `openai`. CI / AC #3 enforces.
 */

/** A plain text content part (transcript or instruction). */
export interface TextContentPart {
  type: "text";
  text: string;
}

/**
 * Audio carried in the OpenAI "input_audio" content convention — base64
 * payload + format hint (`wav`, `mp3`, etc.). Accepted on incoming
 * messages regardless of role.
 */
export interface InputAudioContentPart {
  type: "input_audio";
  input_audio: {
    data: string;
    format: string;
  };
}

/**
 * Audio carried in the alternate "audio" content convention used by some
 * providers (e.g. assistant-role audio replies). Same payload shape as
 * `input_audio` — kept structurally distinct so consumers can switch on
 * the `type` discriminator without losing information.
 */
export interface AudioContentPart {
  type: "audio";
  audio: {
    data: string;
    format: string;
    transcript?: string;
  };
}

/** All content-part shapes an {@link AudioMessageParam} may carry. */
export type AudioMessageContentPart =
  | TextContentPart
  | InputAudioContentPart
  | AudioContentPart;

/** Roles audio messages may flow under — every role, no forceUserRole. */
export type AudioMessageRole = "system" | "user" | "assistant" | "tool";

/**
 * Locally-defined message shape carrying optional audio content parts.
 *
 * Structurally compatible with OpenAI's `ChatCompletionMessageParam` for
 * the cases the voice subsystem produces, but does not depend on the
 * `openai` package's type surface. Branded providers (OpenAI, Anthropic,
 * etc.) can map to/from this shape at their adapter boundary.
 */
export interface AudioMessageParam {
  role: AudioMessageRole;
  content: AudioMessageContentPart[];
  /** Optional tool call id, when `role === "tool"`. */
  tool_call_id?: string;
  /** Optional sender name; matches OpenAI convention. */
  name?: string;
}
