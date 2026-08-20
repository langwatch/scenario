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
 * Opens the session socket. Forwarded to the SDK unchanged; described here
 * structurally so a caller still gets checked without the SDK's own
 * `WebSocketFactory` entering the published types.
 */
export interface ElevenLabsWebSocketFactory {
  create(url: string, ...rest: never[]): unknown;
}

/**
 * Signs the session URL for the `requiresAuth` handshake. Structural for the
 * same reason as {@link ElevenLabsWebSocketFactory}; a real SDK client
 * satisfies it.
 */
export interface ElevenLabsConversationClient {
  conversationalAi: {
    conversations: {
      getSignedUrl(request: { agentId: string }): Promise<unknown>;
    };
  };
}

/** The audio sink the adapter subclasses to bridge SDK audio to the run. */
export interface ElevenLabsAudioInterface {
  start(inputCallback: (audio: Buffer) => void): void;
  stop(): void;
  output(audio: Buffer): void;
  interrupt(): void;
}

/** Constructor for {@link ElevenLabsAudioInterface}, used as a base class. */
export type ElevenLabsAudioInterfaceCtor = new () => ElevenLabsAudioInterface;

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
interface ElevenLabsRuntimeModule {
  AudioInterface: ElevenLabsAudioInterfaceCtor;
  /** Its option bag is wide and SDK-shaped, so it stays a bare constructor. */
  Conversation: new (options: Record<string, unknown>) => ElevenLabsConversation;
  ElevenLabsClient: new (options: { apiKey: string }) => unknown;
}

export async function loadElevenLabsConversationRuntime(): Promise<ElevenLabsRuntimeModule> {
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
    // The casts are the seam itself: the SDK's own declarations would come
    // with the SDK, so each export is narrowed to the shape we drive it by.
    return {
      AudioInterface: (audio as unknown as ElevenLabsRuntimeModule)
        .AudioInterface,
      Conversation: (conversation as unknown as ElevenLabsRuntimeModule)
        .Conversation,
      ElevenLabsClient: (client as unknown as ElevenLabsRuntimeModule)
        .ElevenLabsClient,
    };
  } catch (cause) {
    throw missingSdk(cause);
  }
}
