/**
 * The one place `@elevenlabs/elevenlabs-js` is named, and the only place it is
 * loaded.
 *
 * The SDK is large: importing `@langwatch/scenario` used to pull 5,732 modules
 * and 225MB of RSS, and 4,549 of those modules were ElevenLabs. Every consumer
 * paid that, including a text-only scenario in a server that never does voice,
 * because `index.ts` re-exports the voice namespace and the three ElevenLabs
 * leaves imported the SDK at module scope.
 *
 * Two rules keep it out:
 *
 *  1. **Nothing here re-exports an SDK type.** The interfaces below are
 *     structural views of the parts we actually call, so the published
 *     `index.d.ts` never imports the SDK and a consumer's typecheck never loads
 *     its 2,605 declaration files.
 *  2. **The SDK is imported inside a function body.** Declaration emit only
 *     describes exported signatures, so a dynamic import in a body reaches
 *     neither the types nor the module graph until someone runs voice.
 *
 * Adding a call to a new SDK method means widening the structural type here
 * rather than importing the SDK at a call site.
 */

/** The `speechToText` surface the STT leaf uses. */
export interface ElevenLabsSpeechToText {
  convert(request: {
    file: Blob;
    modelId: string;
  }): Promise<{ text?: string }>;
}

/** The `textToSpeech` surface the TTS leaf uses. */
export interface ElevenLabsTextToSpeech {
  convert(
    voiceId: string,
    request: { text: string; modelId: string; outputFormat: string },
  ): Promise<AsyncIterable<Buffer | Uint8Array>>;
}

/**
 * The client as this SDK uses it. A real `ElevenLabsClient` satisfies it, so
 * callers injecting one through a `clientFactory` need no change.
 */
export interface ElevenLabsClientLike {
  speechToText: ElevenLabsSpeechToText;
  textToSpeech: ElevenLabsTextToSpeech;
}

/** Factory for the client. Injectable, so a test can supply a fake. */
export type ElevenLabsClientFactory = (apiKey: string) => ElevenLabsClientLike;

/**
 * Handed to the SDK unchanged and never called by us, so it is typed as opaque
 * rather than as the SDK's own `WebSocketFactory`. That is what keeps the SDK
 * out of the published types.
 */
export type ElevenLabsWebSocketFactory = object;

/** Handed to the SDK unchanged and never inspected by us. See above. */
export type ElevenLabsConversationClient = object;

/** The live session surface the agent adapter drives. */
export interface ElevenLabsConversation {
  startSession(): Promise<unknown>;
  endSession(): Promise<unknown>;
  isSessionActive(): boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
}

/** Names the missing package rather than letting a bare resolution error escape. */
function missingSdk(cause: unknown): Error {
  return new Error(
    "The ElevenLabs voice backend needs '@elevenlabs/elevenlabs-js'. Install it to use elevenlabs voices, speech-to-text or the ElevenLabs agent adapter.",
    { cause },
  );
}

/** Builds an authenticated client, loading the SDK on first use. */
export async function loadElevenLabsClient(
  apiKey: string,
): Promise<ElevenLabsClientLike> {
  let sdk: { ElevenLabsClient: new (o: { apiKey: string }) => unknown };
  try {
    sdk = (await import("@elevenlabs/elevenlabs-js")) as unknown as typeof sdk;
  } catch (cause) {
    throw missingSdk(cause);
  }
  return new sdk.ElevenLabsClient({ apiKey }) as ElevenLabsClientLike;
}

/**
 * The conversational-AI runtime the agent adapter drives.
 *
 * Deliberately untyped at this boundary: the adapter subclasses `AudioInterface`
 * and constructs `Conversation`, both of which would drag the SDK's types into
 * the published declarations if they were named in an exported signature. The
 * adapter keeps the loaded values inside its own module.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- naming these classes
   in an exported signature is exactly what would put the SDK back into the
   published declarations. The opacity is the point; the adapter keeps them
   inside its own module. */
export async function loadElevenLabsConversationRuntime(): Promise<{
  AudioInterface: any;
  Conversation: any;
  ElevenLabsClient: any;
}> {
  try {
    const [audio, conversation, client] = await Promise.all([
      import(
        "@elevenlabs/elevenlabs-js/api/resources/conversationalAi/conversation/AudioInterface.js"
      ),
      import(
        "@elevenlabs/elevenlabs-js/api/resources/conversationalAi/conversation/Conversation.js"
      ),
      import("@elevenlabs/elevenlabs-js/Client.js"),
    ]);
    return {
      AudioInterface: (audio as any).AudioInterface,
      Conversation: (conversation as any).Conversation,
      ElevenLabsClient: (client as any).ElevenLabsClient,
    };
  } catch (cause) {
    throw missingSdk(cause);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
