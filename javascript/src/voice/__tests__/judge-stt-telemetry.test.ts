/** Judge pre-pass STT span coverage for issue #785. */

import { trace, SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AudioChunk } from "../audio-chunk";
import { prepareJudgeInput, transcribeAudioMessages } from "../judge-stt";
import { createAudioMessage } from "../messages";
import type { STTProvider } from "../stt";

function tone(marker: number): AudioChunk {
  const data = new Uint8Array(4800);
  data.fill(marker);
  return new AudioChunk({ data });
}

function textPart(message: ModelMessage): string | undefined {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const part = content.find(
    (item) =>
      item !== null &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "text",
  ) as { text?: string } | undefined;
  return part?.text;
}

describe("judge pre-pass voice.stt.transcribe spans (#785)", () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
  });

  it("emits a judge-scoped span with success attributes", async () => {
    const stt: STTProvider = {
      transcribe: vi.fn(async () => "account restored"),
    };
    await prepareJudgeInput({
      messages: [createAudioMessage(tone(1), "assistant") as ModelMessage],
      stt,
    });

    const spans = exporter
      .getFinishedSpans()
      .filter((span) => span.name === "voice.stt.transcribe");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes["voice.stt.scope"]).toBe("judge");
    expect(spans[0]!.attributes["voice.stt.speaker"]).toBe("assistant");
    expect(spans[0]!.attributes["voice.stt.audio_bytes"]).toBe(4800);
    expect(spans[0]!.attributes["voice.stt.transcript_chars"]).toBe(
      "account restored".length,
    );
    expect(spans[0]!.attributes["langwatch.span.type"]).toBe("span");
  });

  it("leaves direct transcription uninstrumented by default", async () => {
    const stt: STTProvider = {
      transcribe: vi.fn(async () => "direct transcript"),
    };

    await transcribeAudioMessages({
      messages: [createAudioMessage(tone(1), "user") as ModelMessage],
      stt,
      includeAudio: false,
    });

    const spans = exporter
      .getFinishedSpans()
      .filter((span) => span.name === "voice.stt.transcribe");
    expect(spans).toHaveLength(0);
  });

  it("keeps a successful sibling when one message fails and exports only a sanitized error", async () => {
    const rawError = "401 invalid key sk-secret body={provider response}";
    const stt: STTProvider = {
      async transcribe(audio) {
        if (audio.data[0] === 1) throw new Error(rawError);
        return "successful sibling";
      },
    };
    const warn = vi.fn();
    const messages = [
      createAudioMessage(tone(1), "user") as ModelMessage,
      createAudioMessage(tone(2), "assistant") as ModelMessage,
    ];

    const prepared = await prepareJudgeInput({ messages, stt, logWarn: warn });

    expect(textPart(prepared.messages[0]!)).toBeUndefined();
    expect(textPart(prepared.messages[1]!)).toBe("successful sibling");
    const spans = exporter
      .getFinishedSpans()
      .filter((span) => span.name === "voice.stt.transcribe");
    expect(spans).toHaveLength(2);
    const failed = spans.find((span) => span.status.code === SpanStatusCode.ERROR)!;
    const succeeded = spans.find((span) => span.status.code !== SpanStatusCode.ERROR)!;
    expect(failed.attributes["voice.stt.scope"]).toBe("judge");
    expect(failed.attributes["voice.stt.speaker"]).toBe("user");
    expect(failed.attributes["voice.stt.transcript_chars"]).toBeUndefined();
    expect(succeeded.attributes["voice.stt.transcript_chars"]).toBe(
      "successful sibling".length,
    );
    const recorded = JSON.stringify(failed.events);
    expect(recorded).toContain("STT provider failed");
    expect(recorded).not.toContain("sk-secret");
    expect(recorded).not.toContain("401");
    expect(recorded).not.toContain("provider response");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("STT provider failed: Error");
    expect(warn.mock.calls[0]![0]).not.toContain(rawError);
  });
});
