import { describe, it, expect } from "vitest";
import { CoreMessage } from "ai";
import { JudgeUtils } from "../judge-utils";

describe("JudgeUtils.buildTranscriptFromMessages", () => {
  describe("when messages array is empty", () => {
    it("returns empty string", () => {
      const result = JudgeUtils.buildTranscriptFromMessages([]);
      expect(result).toBe("");
    });
  });

  describe("when messages have string content", () => {
    it("formats single message as role: JSON.stringify(content)", () => {
      const messages: CoreMessage[] = [{ role: "user", content: "hello" }];
      const result = JudgeUtils.buildTranscriptFromMessages(messages);
      expect(result).toBe('user: "hello"');
    });

    it("formats multiple messages with newlines", () => {
      const messages: CoreMessage[] = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ];
      const result = JudgeUtils.buildTranscriptFromMessages(messages);
      expect(result).toBe('user: "hi"\nassistant: "hello"');
    });
  });

  describe("when messages have complex content", () => {
    it("stringifies array content", () => {
      const messages: CoreMessage[] = [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ];
      const result = JudgeUtils.buildTranscriptFromMessages(messages);
      expect(result).toBe('user: [{"type":"text","text":"hello"}]');
    });

    it("includes system messages", () => {
      const messages: CoreMessage[] = [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "hi" },
      ];
      const result = JudgeUtils.buildTranscriptFromMessages(messages);
      expect(result).toBe('system: "You are helpful"\nuser: "hi"');
    });
  });

  describe("when messages contain base64 media", () => {
    it("truncates base64 image data URLs", () => {
      const base64Data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ";
      const messages: CoreMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image", image: `data:image/png;base64,${base64Data}` },
          ],
        },
      ];
      const result = JudgeUtils.buildTranscriptFromMessages(messages);
      expect(result).toBe(
        `user: [{"type":"text","text":"What is this?"},{"type":"image","image":"[IMAGE: image/png, ~${base64Data.length} bytes]"}]`
      );
    });

    it("truncates webp images", () => {
      const base64Data = "UklGRgq1AQBXRUJQVlA4IP60AQBQaQed";
      const messages: CoreMessage[] = [
        {
          role: "user",
          content: `data:image/webp;base64,${base64Data}`,
        },
      ];
      const result = JudgeUtils.buildTranscriptFromMessages(messages);
      expect(result).toBe(
        `user: "[IMAGE: image/webp, ~${base64Data.length} bytes]"`
      );
    });

    it("truncates audio data URLs", () => {
      const base64Data = "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibQ";
      const messages: CoreMessage[] = [
        {
          role: "user",
          content: `data:audio/webm;base64,${base64Data}`,
        },
      ];
      const result = JudgeUtils.buildTranscriptFromMessages(messages);
      expect(result).toBe(
        `user: "[AUDIO: audio/webm, ~${base64Data.length} bytes]"`
      );
    });

    it("truncates mp3 audio", () => {
      const base64Data = "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMA";
      const messages: CoreMessage[] = [
        {
          role: "user",
          content: `data:audio/mpeg;base64,${base64Data}`,
        },
      ];
      const result = JudgeUtils.buildTranscriptFromMessages(messages);
      expect(result).toBe(
        `user: "[AUDIO: audio/mpeg, ~${base64Data.length} bytes]"`
      );
    });

    it("truncates video data URLs", () => {
      const base64Data = "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE";
      const messages: CoreMessage[] = [
        {
          role: "user",
          content: `data:video/mp4;base64,${base64Data}`,
        },
      ];
      const result = JudgeUtils.buildTranscriptFromMessages(messages);
      expect(result).toBe(
        `user: "[VIDEO: video/mp4, ~${base64Data.length} bytes]"`
      );
    });

    it("truncates AI SDK file parts with mediaType", () => {
      const base64Data = "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibQ".repeat(50);
      const messages: CoreMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this audio?" },
            { type: "file", mediaType: "audio/wav", data: base64Data },
          ],
        },
      ];
      const result = JudgeUtils.buildTranscriptFromMessages(messages);
      expect(result).toContain(
        `[AUDIO: audio/wav, ~${base64Data.length} bytes]`
      );
    });

    it("truncates raw base64 in image parts", () => {
      const base64Data = "iVBORw0KGgoAAAANSUhEUg".repeat(100);
      const messages: CoreMessage[] = [
        {
          role: "user",
          content: [{ type: "image", image: base64Data }],
        },
      ];
      const result = JudgeUtils.buildTranscriptFromMessages(messages);
      expect(result).toContain(`[IMAGE: unknown, ~${base64Data.length} bytes]`);
    });
  });
});

