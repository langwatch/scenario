/**
 * OpenAIRealtimeAgentAdapter — direct-to-model adapter where the model
 * IS the agent (or, when `role=AgentRole.USER`, the voice-enabled user
 * simulator).
 *
 * Port of `python/scenario/voice/adapters/openai_realtime.py` (source §5.6
 * and §7.2 L1164-1171). Unlike the wrapper adapters (Pipecat, Twilio,
 * etc.), this adapter speaks the OpenAI Realtime wire protocol itself.
 *
 * Wire protocol (GA, post-2026-05-22 — the Beta surface is gone):
 * - Endpoint: `wss://api.openai.com/v1/realtime?model=<model>`
 * - Headers: `Authorization: Bearer <api_key>` (the `OpenAI-Beta: realtime=v1`
 *   opt-in is rejected outright by the GA endpoint).
 * - On connect: emit `session.update` with `session.type: "realtime"`,
 *   audio formats under `session.audio.{input,output}.format`, voice under
 *   `session.audio.output.voice`, transcription/turn_detection nested
 *   under `session.audio.input`.
 * - Send audio: `input_audio_buffer.append` with base64-encoded PCM16.
 * - Receive audio: loop over server events until
 *   `response.output_audio.delta` (Beta-era `response.audio.delta` is
 *   also accepted); return decoded PCM16. Transcript events update
 *   instance attributes.
 * - Send text (role=USER): `conversation.item.create` (input_text) then
 *   `response.create`.
 */

import WebSocket, { type RawData } from "ws";

import { AgentRole } from "../../domain/agents";
import { VoiceAgentAdapter } from "../adapter";
import { AudioChunk } from "../audio-chunk";
import { AdapterCapabilities } from "../capabilities";
import { OPENAI_REALTIME_MODEL, OPENAI_STT_MODEL } from "../voice-models";

const REALTIME_URL_TEMPLATE = "wss://api.openai.com/v1/realtime?model={model}";

/**
 * Realtime tool definition — structural shape passed through to the
 * `session.update` payload. Tightened from `unknown[]` so call-site typos
 * surface at compile time; extra fields are still allowed via the
 * intersection index signature.
 */
export type RealtimeToolDef = {
  type: "function";
  name: string;
  description?: string;
  parameters?: unknown;
} & Record<string, unknown>;

export interface OpenAIRealtimeAgentAdapterInit {
  /** Realtime model id. Defaults to {@link OPENAI_REALTIME_MODEL}. */
  model?: string;
  /** Voice id (e.g. "alloy", "nova"). */
  voice?: string;
  /** System instructions passed via `session.update`. */
  instructions?: string;
  /** Tool definitions passed straight through to the Realtime session. */
  tools?: RealtimeToolDef[];
  /** Explicit API key; falls back to `process.env.OPENAI_API_KEY`. */
  apiKey?: string;
  /**
   * `AGENT` (default) makes the model the agent under test. `USER` turns
   * it into the voice-enabled user simulator — scripted `user("text")`
   * steps route through `sendText` and bypass the TTS pipeline.
   */
  role?: AgentRole;
  /**
   * Override the Realtime endpoint URL. Defaults to
   * `wss://api.openai.com/v1/realtime?model=<model>`. Lets tests point at
   * a loopback WS server without subclassing the adapter.
   */
  url?: string;
}

/**
 * Exercise OpenAI's Realtime API as either the agent under test
 * (`role=AGENT`, default) or as the voice-enabled user simulator
 * (`role=USER`, per §7.2 L1164-1171).
 *
 * When `role=USER`, scripted `user("text")` steps route text through the
 * realtime session's text-input channel rather than triggering TTS.
 *
 * Transcript observability:
 * - `lastUserTranscript` — set from
 *   `conversation.item.input_audio_transcription.completed`
 * - `lastAgentTranscript` — accumulated from
 *   `response.audio_transcript.delta` / reset on done
 */
export class OpenAIRealtimeAgentAdapter extends VoiceAgentAdapter {
  readonly capabilities: AdapterCapabilities = new AdapterCapabilities({
    streamingTranscripts: true,
    nativeVad: true,
    dtmf: false,
    // OpenAI Realtime exposes `response.cancel` as a first-class interrupt
    // — the model stops generating immediately. Mapped in `interrupt()`.
    interruption: true,
    inputFormats: ["pcm16/24000"],
    outputFormats: ["pcm16/24000"],
  });

  readonly model: string;
  readonly voice: string;
  readonly instructions: string;
  readonly tools: RealtimeToolDef[];
  override role: AgentRole;

  /** Most recent user-side transcript from the Whisper input pipeline. */
  lastUserTranscript: string | null = null;
  /** Most recent finalized agent transcript (post `audio_transcript.done`). */
  lastAgentTranscript: string | null = null;

  private readonly _apiKey: string;
  private readonly _urlOverride: string | null;
  private _ws: WebSocket | null = null;
  // Streaming agent transcript buffer — accumulates deltas, flushed on done.
  private _agentTranscriptBuf = "";
  // Bytes appended to `input_audio_buffer` since the last commit. Non-zero
  // means `receiveAudio` must commit + request a response before awaiting.
  private _pendingAudioBytes = 0;
  // Inbound event queue + waiter handle. Bridges the `ws` callback-style
  // API into the awaitable loop in `receiveAudio`.
  private readonly _eventQueue: unknown[] = [];
  private _waitResolve: ((evt: unknown) => void) | null = null;
  private _waitReject: ((err: Error) => void) | null = null;
  private _closeReason: Error | null = null;

  constructor(init: OpenAIRealtimeAgentAdapterInit = {}) {
    super();
    this.model = init.model ?? OPENAI_REALTIME_MODEL;
    this.voice = init.voice ?? "alloy";
    this.instructions = init.instructions ?? "";
    this.tools = init.tools ?? [];
    this.role = init.role ?? AgentRole.AGENT;
    this._apiKey = init.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this._urlOverride = init.url ?? null;
  }

  get url(): string {
    return (
      this._urlOverride ?? REALTIME_URL_TEMPLATE.replace("{model}", this.model)
    );
  }

  /** Hide the API key when this object lands in error messages or logs. */
  toString(): string {
    return (
      `OpenAIRealtimeAgentAdapter(model='${this.model}', ` +
      `voice='${this.voice}', role='${this.role}', api_key='***')`
    );
  }

  // call() is inherited from VoiceAgentAdapter (defaultVoiceCall) — the executor
  // runtime drives the audio loop (Gap #11). No leaf-level override.

  // ------------------------------------------------------------ lifecycle

  /** Open the Realtime WebSocket and send the initial `session.update`. */
  async connect(): Promise<void> {
    if (!this._apiKey) {
      throw new Error(
        "OpenAIRealtimeAgentAdapter: no API key. Set OPENAI_API_KEY or " +
          "pass `{ apiKey }` to the constructor.",
      );
    }
    // No `OpenAI-Beta: realtime=v1` header — that opt-in is the deprecated
    // Beta. The GA endpoint at `/v1/realtime` rejects the header outright
    // with "The Realtime Beta API is no longer supported." (observed in
    // CI 2026-05-22). Python parity is intentionally broken here; track
    // for back-port.
    const ws = new WebSocket(this.url, {
      headers: {
        Authorization: `Bearer ${this._apiKey}`,
      },
    });

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.off("error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        ws.off("open", onOpen);
        reject(err);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });

    ws.on("message", (raw: RawData) => this._handleMessage(raw));
    ws.on("close", () => {
      const err = new Error("OpenAIRealtimeAgentAdapter: socket closed");
      this._closeReason = err;
      if (this._waitReject) {
        const reject = this._waitReject;
        this._waitResolve = null;
        this._waitReject = null;
        reject(err);
      }
    });
    ws.on("error", (err: Error) => {
      this._closeReason = err;
      if (this._waitReject) {
        const reject = this._waitReject;
        this._waitResolve = null;
        this._waitReject = null;
        reject(err);
      }
    });

    this._ws = ws;

    // Configure session per the GA Realtime spec (RealtimeSessionCreateRequest
    // in openai-node `realtime.ts`): `session.type` discriminates the
    // session kind; audio formats live under `session.audio.{input,output}`;
    // turn detection sits under `session.audio.input` so it can be `null`
    // (which puts us in control of turn boundaries — we call commit +
    // response.create after each sendAudio).
    const sessionConfig: Record<string, unknown> = {
      type: "realtime",
      model: this.model,
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription: { model: OPENAI_STT_MODEL },
          turn_detection: null,
        },
        output: {
          format: { type: "audio/pcm", rate: 24000 },
          voice: this.voice,
        },
      },
    };
    if (this.instructions) sessionConfig.instructions = this.instructions;
    if (this.tools.length > 0) sessionConfig.tools = this.tools;

    ws.send(JSON.stringify({ type: "session.update", session: sessionConfig }));
  }

  /** Whether the Realtime WebSocket is open (Gap #11). */
  override isConnected(): boolean {
    return this._ws !== null;
  }

  /** Close the WebSocket if open. */
  async disconnect(): Promise<void> {
    const ws = this._ws;
    if (!ws) return;
    this._ws = null;
    // Synchronously fail any in-flight receiveAudio waiter so callers
    // unblock immediately on disconnect — don't rely on the async close
    // handler firing first. Also drain queued events: a partially-
    // delivered response is no longer reachable across a closed socket.
    const closeErr = new Error("OpenAIRealtimeAgentAdapter: disconnected");
    this._closeReason = closeErr;
    this._eventQueue.length = 0;
    if (this._waitReject) {
      const reject = this._waitReject;
      this._waitResolve = null;
      this._waitReject = null;
      reject(closeErr);
    }
    try {
      ws.close();
    } catch {
      // Best-effort: connection may already be half-closed or in an error
      // state when disconnect() is called. We're tearing down regardless;
      // propagating here would just leak the WS reference.
    }
  }

  // ------------------------------------------------------------------- I/O

  /**
   * Append a PCM16 audio chunk to the model's input audio buffer.
   *
   * Only emits `input_audio_buffer.append` — commit + response are deferred
   * to the next `receiveAudio` call. The executor may call `sendAudio` many
   * times for a single user turn (TTS streams audio as chunks); committing
   * per-chunk would confuse the server with sub-second turn boundaries.
   */
  async sendAudio(chunk: AudioChunk): Promise<void> {
    if (!this._ws) {
      throw new Error("OpenAIRealtimeAgentAdapter: not connected");
    }
    const b64 = Buffer.from(chunk.data).toString("base64");
    this._ws.send(
      JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }),
    );
    this._pendingAudioBytes += chunk.data.length;
  }

  /**
   * Send `response.cancel` — the OpenAI Realtime API's first-class
   * interrupt. The model stops generating audio and text immediately. No
   * timing race against VAD: deterministic stop, then the next user turn
   * flows normally through `sendAudio` + `receiveAudio`.
   */
  async interrupt(): Promise<void> {
    if (!this._ws) {
      throw new Error("OpenAIRealtimeAgentAdapter: not connected");
    }
    this._ws.send(JSON.stringify({ type: "response.cancel" }));
  }

  /**
   * Commit any pending audio, request a response, and return the first
   * audio chunk the model produces.
   *
   * Loops over incoming events until a `response.output_audio.delta`
   * event arrives, then returns decoded PCM16. Transcript events update
   * `lastUserTranscript` / `lastAgentTranscript`. An `error` event throws.
   *
   * GA event names are `response.output_audio[_transcript].{delta,done}`
   * (the Beta `response.audio[_transcript].*` names are dead). We accept
   * both so back-port to a Beta endpoint stays trivial; production hits
   * the GA path.
   */
  async receiveAudio(timeout: number): Promise<AudioChunk> {
    if (!this._ws) {
      throw new Error("OpenAIRealtimeAgentAdapter: not connected");
    }

    if (this._pendingAudioBytes > 0) {
      this._ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      this._ws.send(JSON.stringify({ type: "response.create" }));
      this._pendingAudioBytes = 0;
    }

    const deadline = Date.now() + timeout * 1000;
    // Single source of truth for the timeout: `_nextEvent` arms a timer
    // against `remaining` and rejects with the timeout error when it
    // fires. The outer-loop guard is redundant — the inner timer always
    // wins the race.
    while (true) {
      const remaining = deadline - Date.now();
      const event = await this._nextEvent(remaining);
      const etype = (event as { type?: string }).type ?? "";

      if (
        etype === "response.output_audio.delta" ||
        etype === "response.audio.delta"
      ) {
        const delta = (event as { delta?: string }).delta ?? "";
        // PCM16 invariant: even byte count. The AudioChunk constructor
        // throws on odd-byte buffers — surface the upstream codec bug
        // there rather than silently truncating here.
        return new AudioChunk({ data: new Uint8Array(Buffer.from(delta, "base64")) });
      }

      if (
        etype === "response.output_audio_transcript.delta" ||
        etype === "response.audio_transcript.delta"
      ) {
        this._agentTranscriptBuf += (event as { delta?: string }).delta ?? "";
      } else if (
        etype === "response.output_audio_transcript.done" ||
        etype === "response.audio_transcript.done"
      ) {
        const transcript =
          (event as { transcript?: string }).transcript ?? "";
        if (transcript) {
          this.lastAgentTranscript = transcript;
        } else if (this._agentTranscriptBuf) {
          this.lastAgentTranscript = this._agentTranscriptBuf;
        }
        this._agentTranscriptBuf = "";
      } else if (
        etype === "conversation.item.input_audio_transcription.completed"
      ) {
        this.lastUserTranscript =
          (event as { transcript?: string }).transcript ?? "";
      } else if (etype === "error") {
        const errDetail =
          (event as { error?: { message?: string } }).error ?? {};
        const msg = errDetail.message ?? JSON.stringify(errDetail);
        throw new Error(`OpenAIRealtimeAgentAdapter: server error — ${msg}`);
      }
      // Housekeeping events (session.created, response.created, ...) are
      // ignored and the loop continues.
    }
  }

  /**
   * Inject scripted text into the realtime session as a user message.
   *
   * Used when this adapter is the user simulator (`role=USER`): scripted
   * `user("text")` steps route through here instead of spawning TTS. The
   * model synthesizes the text into spoken audio with natural prosody,
   * which is then delivered via `receiveAudio`.
   *
   * Per §7.2, OpenAI Realtime cannot populate assistant audio messages
   * retroactively; the downstream transcript reflects what the model
   * actually emitted, not what was scripted.
   */
  async sendText(text: string): Promise<void> {
    if (!this._ws) {
      throw new Error("OpenAIRealtimeAgentAdapter: not connected");
    }
    this._ws.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      }),
    );
    this._ws.send(JSON.stringify({ type: "response.create" }));
  }

  // ----------------------------------------------------------------- inner

  private _handleMessage(raw: RawData): void {
    let payload: string;
    if (typeof raw === "string") {
      payload = raw;
    } else if (Buffer.isBuffer(raw)) {
      payload = raw.toString("utf8");
    } else if (Array.isArray(raw)) {
      payload = Buffer.concat(raw).toString("utf8");
    } else {
      payload = Buffer.from(raw as ArrayBuffer).toString("utf8");
    }

    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      // Non-JSON frame — match Python adapter behavior and drop it.
      return;
    }
    this._enqueueEvent(event);
  }

  private _enqueueEvent(event: unknown): void {
    if (this._waitResolve) {
      const resolve = this._waitResolve;
      this._waitResolve = null;
      this._waitReject = null;
      resolve(event);
      return;
    }
    this._eventQueue.push(event);
  }

  private _nextEvent(timeoutMs: number): Promise<unknown> {
    if (this._closeReason) {
      return Promise.reject(this._closeReason);
    }
    const queued = this._eventQueue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waitResolve = null;
        this._waitReject = null;
        reject(
          new Error("OpenAIRealtimeAgentAdapter: receiveAudio timed out"),
        );
      }, Math.max(0, timeoutMs));
      this._waitResolve = (evt) => {
        clearTimeout(timer);
        resolve(evt);
      };
      this._waitReject = (err) => {
        clearTimeout(timer);
        reject(err);
      };
    });
  }
}
