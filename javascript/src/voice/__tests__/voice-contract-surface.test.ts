/**
 * Voice contract surface tests — PR1 of issue #372.
 *
 * Binds the five scenarios from `specs/voice-agents.feature` that the PR1
 * scope is responsible for; concrete adapters and runtime behavior land in
 * PR2+ and bring their own tests.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AgentAdapter, AgentRole } from "../../domain/agents";
import {
  AdapterCapabilities,
  AudioChunk,
  PCM16_CHANNELS,
  PCM16_SAMPLE_RATE,
  PCM16_SAMPLE_WIDTH_BYTES,
  UnsupportedCapabilityError,
  VoiceAgentAdapter,
  silentChunk,
} from "../index";

const HERE = dirname(fileURLToPath(import.meta.url));
const MATRIX_DOC_PATH = resolve(
  HERE,
  "..",
  "..",
  "..",
  "docs",
  "voice",
  "capability-matrix.md",
);

class StubVoiceAdapter extends VoiceAgentAdapter {
  override role = AgentRole.AGENT;
  readonly capabilities = new AdapterCapabilities({
    streamingTranscripts: true,
    nativeVad: true,
    dtmf: false,
    interruption: true,
    inputFormats: ["pcm16/24000"],
    outputFormats: ["pcm16/24000"],
  });

  connectCount = 0;
  disconnectCount = 0;
  sent: AudioChunk[] = [];

  async call(): Promise<string> {
    return "stub";
  }
  async connect(): Promise<void> {
    this.connectCount += 1;
  }
  async disconnect(): Promise<void> {
    this.disconnectCount += 1;
  }
  async sendAudio(chunk: AudioChunk): Promise<void> {
    this.sent.push(chunk);
  }
  async receiveAudio(_timeout: number): Promise<AudioChunk> {
    return silentChunk(0.01);
  }
}

describe("specs/voice-agents.feature lines 146-156 — AudioChunk internal format is PCM16 at 24kHz mono", () => {
  it("normalizes the canonical internal format to PCM16 / 24000 Hz / mono", () => {
    // "Then the internal AudioChunk is PCM16, 24000 Hz, mono"
    expect(PCM16_SAMPLE_RATE).toBe(24000);
    expect(PCM16_CHANNELS).toBe(1);
    expect(PCM16_SAMPLE_WIDTH_BYTES).toBe(2);

    const chunk = silentChunk(0.5);
    expect(chunk.sampleRate).toBe(24000);
    expect(chunk.channels).toBe(1);
    expect(chunk.durationSeconds).toBeCloseTo(0.5, 3);
  });

  it("rejects odd-byte buffers — partial PCM16 samples surface at the boundary", () => {
    // The PCM16 invariant catches partial transport frames at the canonical
    // boundary instead of letting `frombuffer`/`durationSeconds` silently
    // truncate and produce off-by-one drift.
    expect(
      () => new AudioChunk({ data: new Uint8Array([0x00, 0x00, 0x01]) }),
    ).toThrowError(/not a multiple of 2/);
  });
});

describe("specs/voice-agents.feature lines 698-704 — VoiceAgentAdapter base class is public for custom implementations", () => {
  it("lets user code subclass it with connect/sendAudio/receiveAudio/disconnect", async () => {
    const adapter = new StubVoiceAdapter();
    expect(adapter).toBeInstanceOf(VoiceAgentAdapter);
    expect(adapter).toBeInstanceOf(AgentAdapter);

    // Public surface — every method exposed by the contract is callable on
    // the subclass instance.
    await adapter.connect();
    await adapter.sendAudio(silentChunk(0.02));
    const received = await adapter.receiveAudio(1);
    await adapter.disconnect();

    expect(adapter.connectCount).toBe(1);
    expect(adapter.disconnectCount).toBe(1);
    expect(adapter.sent).toHaveLength(1);
    expect(received).toBeInstanceOf(AudioChunk);
  });
});

describe("specs/voice-agents.feature lines 751-756 — Every adapter publishes a capabilities attribute", () => {
  it("declares streamingTranscripts / nativeVad / dtmf / inputFormats / outputFormats", () => {
    const adapter = new StubVoiceAdapter();
    expect(adapter.capabilities).toBeInstanceOf(AdapterCapabilities);

    // Field-name parity with the spec — the AC enumerates the five
    // capabilities every adapter must publish.
    const caps = adapter.capabilities;
    expect(typeof caps.streamingTranscripts).toBe("boolean");
    expect(typeof caps.nativeVad).toBe("boolean");
    expect(typeof caps.dtmf).toBe("boolean");
    expect(Array.isArray(caps.inputFormats)).toBe(true);
    expect(Array.isArray(caps.outputFormats)).toBe(true);
  });

  it("defaults to the safest possible declaration when no flags are set", () => {
    // An adapter author who forgets to declare anything must NOT silently
    // claim every capability. Default is "supports nothing".
    const empty = new AdapterCapabilities();
    expect(empty.streamingTranscripts).toBe(false);
    expect(empty.nativeVad).toBe(false);
    expect(empty.dtmf).toBe(false);
    expect(empty.interruption).toBe(false);
    expect(empty.inputFormats).toEqual([]);
    expect(empty.outputFormats).toEqual([]);
  });
});

describe("specs/voice-agents.feature lines 757-762 — UnsupportedCapabilityError naming", () => {
  it("names the adapter and the missing capability in the error message", () => {
    // The spec's example fires when `scenario.dtmf("1")` runs on a
    // non-telephony adapter; we exercise the raise-only stub shape here —
    // adapter name + capability both surfaced for downstream UX.
    const err = new UnsupportedCapabilityError("StubVoiceAdapter", "dtmf");
    expect(err).toBeInstanceOf(Error);
    expect(err.adapterName).toBe("StubVoiceAdapter");
    expect(err.capability).toBe("dtmf");
    expect(err.message).toContain("StubVoiceAdapter");
    expect(err.message).toContain("dtmf");
    expect(err.message).toContain("docs/voice/capability-matrix.md");
  });

  it("the base interrupt() throws UnsupportedCapabilityError on adapters without override", () => {
    class NoInterruptAdapter extends VoiceAgentAdapter {
      readonly capabilities = new AdapterCapabilities();
      async call(): Promise<string> {
        return "stub";
      }
      async connect(): Promise<void> {}
      async disconnect(): Promise<void> {}
      async sendAudio(_chunk: AudioChunk): Promise<void> {}
      async receiveAudio(_timeout: number): Promise<AudioChunk> {
        return silentChunk(0);
      }
    }

    const adapter = new NoInterruptAdapter();
    expect(() => adapter.interrupt()).toThrow(UnsupportedCapabilityError);
  });
});

describe("specs/voice-agents.feature lines 763-771 — Capability matrix is rendered into adapter docs", () => {
  const doc = readFileSync(MATRIX_DOC_PATH, "utf8");

  it("renders a table that lists every shipped + planned adapter", () => {
    // Same adapter set as the Python source-of-truth at
    // docs/voice/capability-matrix.md — PR1 placeholder, real flags land
    // alongside each adapter PR (#372 PR2+).
    const adapters = [
      "PipecatAgentAdapter",
      "TwilioAgentAdapter",
      "OpenAIRealtimeAgentAdapter",
      "ElevenLabsAgentAdapter",
      "GeminiLiveAgentAdapter",
      "LiveKitAgentAdapter",
      "VapiAgentAdapter",
      "WebRTCAgentAdapter",
      "WebSocketAgentAdapter",
    ];
    for (const adapter of adapters) {
      expect(doc).toContain(adapter);
    }
  });

  it("table header lists streaming_transcripts, native_vad, dtmf, and input/output formats", () => {
    // The AC enumerates the columns the doc must surface — the column
    // headers are in human prose in the table header row.
    expect(doc.toLowerCase()).toContain("streaming transcripts");
    expect(doc.toLowerCase()).toContain("native vad");
    expect(doc.toLowerCase()).toContain("dtmf");
    expect(doc.toLowerCase()).toContain("wire formats");
  });
});
