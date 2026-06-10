import { describe, it, expect } from "vitest";
import { convertModelMessagesToAguiMessages } from "./convert-core-messages-to-agui-messages";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeModelMessage(partial: any): any {
  return {
    id: "core-id",
    ...partial,
  };
}

describe("convertModelMessagesToAguiMessages", () => {
  it("converts a system message", () => {
    const input = [makeModelMessage({ role: "system", content: "sys" })];
    const result = convertModelMessagesToAguiMessages(input);
    expect(result).toEqual([{ id: "core-id", role: "system", content: "sys" }]);
  });

  it("converts a user message with string content", () => {
    const input = [makeModelMessage({ role: "user", content: "hello" })];
    const result = convertModelMessagesToAguiMessages(input);
    expect(result).toEqual([{ id: "core-id", role: "user", content: "hello" }]);
  });

  it("collapses a user message with a single bare text part to a plain string", () => {
    const arr = [{ type: "text", text: "hi" }];
    const input = [makeModelMessage({ role: "user", content: arr })];
    const result = convertModelMessagesToAguiMessages(input);
    expect(result).toEqual([
      { id: "core-id", role: "user", content: "hi" },
    ]);
  });

  it("converts an assistant message with string content", () => {
    const input = [makeModelMessage({ role: "assistant", content: "response" })];
    const result = convertModelMessagesToAguiMessages(input);
    expect(result).toEqual([
      { id: "core-id", role: "assistant", content: "response" },
    ]);
  });

  it("converts an assistant message with array content (non-tool parts pass through as an array)", () => {
    const arr = [
      { type: "tool-call", toolCallId: "t1", toolName: "fn", input: { foo: 1 } },
      { type: "json", value: { bar: 2 } },
    ];
    const input = [makeModelMessage({ role: "assistant", content: arr })];
    const result = convertModelMessagesToAguiMessages(input);
    // Array content is preserved verbatim so the langwatch ingest content-
    // extractor can walk it (pre-stringifying would hide inline media from
    // externalisation — see file header). The langwatch ingest schema accepts
    // array content via `chatMessageSchema`.
    expect(result[0].content as unknown).toEqual([
      { type: "json", value: { bar: 2 } },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result[0] as any).toolCalls).toEqual([
      {
        id: "t1",
        type: "function",
        function: {
          name: "fn",
          arguments: JSON.stringify({ foo: 1 }),
        },
      },
    ]);
  });

  it("converts a tool message with multiple parts", () => {
    const arr = [
      { type: "tool-result", toolName: "tool1", toolCallId: "t1", output: { type: "json", value: { foo: "bar" } } },
      { type: "tool-result", toolName: "tool2", toolCallId: "t2", output: { type: "json", value: { baz: 42 } } },
    ];
    const input = [makeModelMessage({ role: "tool", content: arr })];
    const result = convertModelMessagesToAguiMessages(input);
    expect(result).toEqual([
      {
        id: "core-id-0",
        role: "tool",
        toolCallId: "t1",
        content: JSON.stringify({ foo: "bar" }),
      },
      {
        id: "core-id-1",
        role: "tool",
        toolCallId: "t2",
        content: JSON.stringify({ baz: 42 }),
      },
    ]);
  });

  it("throws on unsupported message role", () => {
    const input = [makeModelMessage({ role: "banana", content: "nope" })];
    expect(() => convertModelMessagesToAguiMessages(input)).toThrow();
  });

  describe("audio content normalisation", () => {
    it("translates AI-SDK file+audio parts to OpenAI input_audio shape", () => {
      const arr = [
        { type: "text", text: "Hello" },
        { type: "file", mediaType: "audio/wav", data: "BASE64BYTES" },
      ];
      const input = [makeModelMessage({ role: "user", content: arr })];
      const result = convertModelMessagesToAguiMessages(input);
      expect(result[0].content as unknown).toEqual([
        { type: "text", text: "Hello" },
        {
          type: "input_audio",
          input_audio: {
            data: "BASE64BYTES",
            format: "wav",
            mimeType: "audio/wav",
          },
        },
      ]);
    });

    it("WAV-wraps raw pcm16 audio at the langwatch boundary so players can decode it", () => {
      const arr = [
        { type: "file", mediaType: "audio/pcm16", data: "BASE64BYTES" },
      ];
      const input = [makeModelMessage({ role: "assistant", content: arr })];
      const result = convertModelMessagesToAguiMessages(input);
      expect(result[0].content as unknown).toEqual([
        {
          type: "input_audio",
          input_audio: {
            // Raw headerless PCM16 is undecodable by a browser <audio>
            // element, so the langwatch-bound converter wraps it in a RIFF/WAV
            // container (24kHz mono 16-bit — the AudioChunk contract; matches
            // the Python twin's shipped `format:"wav"`). Deterministic for the
            // fixture bytes: base64 starts "UklGRi" = "RIFF".
            data: "UklGRiwAAABXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YQgAAAAEBITrgFhMRA==",
            format: "wav",
            mimeType: "audio/wav",
          },
        },
      ]);
    });

    it("leaves non-audio file parts untouched", () => {
      const arr = [
        { type: "file", mediaType: "image/png", data: "PNGBYTES" },
      ];
      const input = [makeModelMessage({ role: "user", content: arr })];
      const result = convertModelMessagesToAguiMessages(input);
      expect(result[0].content as unknown).toEqual([
        { type: "file", mediaType: "image/png", data: "PNGBYTES" },
      ]);
    });
  });
});
