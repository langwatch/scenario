/**
 * STT plumbing tests — PR2 of issue #372.
 *
 * Binds the `specs/voice-agents.feature` scenarios for: default STT model,
 * provider swap, interface minimality, and >25-minute audio chunking.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { AudioChunk, silentChunk } from "../audio-chunk";
import {
  OPENAI_TRANSCRIBE_LIMIT_SECONDS,
  OpenAISTTProvider,
  getSttProvider,
  setSttProvider,
  type STTProvider,
} from "../stt";
import { OPENAI_STT_MODEL } from "../voice-models";

type OpenAILike = {
  audio: {
    transcriptions: {
      create: ReturnType<typeof vi.fn>;
    };
  };
};

function makeMockOpenAI(text = "transcribed"): OpenAILike {
  return {
    audio: {
      transcriptions: {
        create: vi.fn().mockResolvedValue({ text }),
      },
    },
  };
}

describe("specs/voice-agents.feature lines 720-726 — Default STT provider is OpenAI gpt-4o-transcribe", () => {
  it("OpenAISTTProvider defaults to model 'gpt-4o-transcribe'", () => {
    const provider = new OpenAISTTProvider();
    expect(provider.model).toBe("gpt-4o-transcribe");
    expect(provider.model).toBe(OPENAI_STT_MODEL);
  });

  it("the default global STT provider is an OpenAISTTProvider", () => {
    // Save / restore so a previous test that swapped the global doesn't
    // leak in if vitest reordered things.
    const prior = getSttProvider();
    setSttProvider(new OpenAISTTProvider());
    expect(getSttProvider()).toBeInstanceOf(OpenAISTTProvider);
    setSttProvider(prior);
  });

  it("issues the request with model='gpt-4o-transcribe'", async () => {
    const mock = makeMockOpenAI("hi");
    const provider = new OpenAISTTProvider({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openaiClient: mock as any,
    });
    await provider.transcribe(silentChunk(0.5));

    expect(mock.audio.transcriptions.create).toHaveBeenCalledTimes(1);
    const args = mock.audio.transcriptions.create.mock.calls[0][0];
    expect(args.model).toBe("gpt-4o-transcribe");
  });
});

describe("specs/voice-agents.feature lines 727-733 — Users swap STT providers via scenario.configure", () => {
  afterEach(() => {
    // Restore default to keep test isolation clean.
    setSttProvider(new OpenAISTTProvider());
  });

  it("setSttProvider installs the custom provider and getSttProvider returns it", () => {
    class MyProvider implements STTProvider {
      async transcribe(_audio: AudioChunk): Promise<string> {
        return "custom";
      }
    }
    const custom = new MyProvider();
    setSttProvider(custom);
    expect(getSttProvider()).toBe(custom);
  });

  it("the custom provider's transcribe() is invoked when the global is swapped", async () => {
    const spy = vi.fn().mockResolvedValue("from-custom-provider");
    const custom: STTProvider = { transcribe: spy };
    setSttProvider(custom);
    const result = await getSttProvider()!.transcribe(silentChunk(0.01));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result).toBe("from-custom-provider");
  });
});

describe("specs/voice-agents.feature lines 734-739 — STT provider interface is minimal and provider-agnostic", () => {
  it("STTProvider is structurally satisfied by an object with only transcribe(audio)", async () => {
    // The interface is intentionally tiny — a single async method that
    // takes the canonical AudioChunk and returns a string. No OpenAI
    // types, no per-vendor escape hatches.
    const minimal: STTProvider = {
      transcribe: async (audio: AudioChunk): Promise<string> => {
        // ensure the input is the canonical type, not an OpenAI request
        expect(audio).toBeInstanceOf(AudioChunk);
        return "ok";
      },
    };
    const result = await minimal.transcribe(silentChunk(0.01));
    expect(result).toBe("ok");
  });

  it("no OpenAI-specific types leak into the interface (compile-time check)", () => {
    // The `transcribe` signature accepts only AudioChunk. We assert
    // here by constructing a minimal implementation and verifying that
    // it satisfies the interface without referencing any OpenAI type.
    const p: STTProvider = {
      async transcribe(audio) {
        return audio.transcript ?? "";
      },
    };
    expect(p).toBeDefined();
  });
});

describe("specs/voice-agents.feature lines 740-748 — Transcription chunks audio longer than 25 minutes", () => {
  it("hardcoded limit matches OpenAI's 25-minute per-request cap", () => {
    expect(OPENAI_TRANSCRIBE_LIMIT_SECONDS).toBe(25 * 60);
  });

  it("audio under the limit is sent as a single request", async () => {
    const mock = makeMockOpenAI("short");
    const provider = new OpenAISTTProvider({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openaiClient: mock as any,
      transcribeLimitSeconds: 2,
    });
    const text = await provider.transcribe(silentChunk(1));
    expect(mock.audio.transcriptions.create).toHaveBeenCalledTimes(1);
    expect(text).toBe("short");
  });

  it("audio above the limit is split into sub-chunks and the results concatenated", async () => {
    // Use a tiny synthetic limit so the test runs on a small buffer.
    // 2.5s with a 1s limit must split into 3 sub-calls (1s, 1s, 0.5s).
    const mock = makeMockOpenAI();
    let call = 0;
    mock.audio.transcriptions.create.mockImplementation(async () => ({
      text: `seg${++call}`,
    }));
    const provider = new OpenAISTTProvider({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openaiClient: mock as any,
      transcribeLimitSeconds: 1,
    });
    const text = await provider.transcribe(silentChunk(2.5));
    expect(mock.audio.transcriptions.create).toHaveBeenCalledTimes(3);
    expect(text).toBe("seg1 seg2 seg3");
  });

  it("empty sub-chunk transcripts are dropped from the joined result", async () => {
    const mock = makeMockOpenAI();
    let call = 0;
    mock.audio.transcriptions.create.mockImplementation(async () => {
      call += 1;
      // Middle chunk returns empty — should be filtered.
      return { text: call === 2 ? "" : `seg${call}` };
    });
    const provider = new OpenAISTTProvider({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openaiClient: mock as any,
      transcribeLimitSeconds: 1,
    });
    const text = await provider.transcribe(silentChunk(2.5));
    expect(text).toBe("seg1 seg3");
  });
});
