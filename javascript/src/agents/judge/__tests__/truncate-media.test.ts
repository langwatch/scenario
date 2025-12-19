import { describe, it, expect } from "vitest";

import { truncateMediaUrl, truncateMediaPart } from "../truncate-media";

describe("truncateMediaUrl", () => {
  describe("when string is a data URL", () => {
    it("truncates image/png", () => {
      const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ";
      const dataUrl = `data:image/png;base64,${base64}`;
      expect(truncateMediaUrl(dataUrl)).toBe(
        `[IMAGE: image/png, ~${base64.length} bytes]`
      );
    });

    it("truncates image/jpeg", () => {
      const base64 = "/9j/4AAQSkZJRgABAQEASABIAAD";
      const dataUrl = `data:image/jpeg;base64,${base64}`;
      expect(truncateMediaUrl(dataUrl)).toBe(
        `[IMAGE: image/jpeg, ~${base64.length} bytes]`
      );
    });

    it("truncates audio/webm", () => {
      const base64 = "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibQ";
      const dataUrl = `data:audio/webm;base64,${base64}`;
      expect(truncateMediaUrl(dataUrl)).toBe(
        `[AUDIO: audio/webm, ~${base64.length} bytes]`
      );
    });

    it("truncates video/mp4", () => {
      const base64 = "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE";
      const dataUrl = `data:video/mp4;base64,${base64}`;
      expect(truncateMediaUrl(dataUrl)).toBe(
        `[VIDEO: video/mp4, ~${base64.length} bytes]`
      );
    });
  });

  describe("when string is not a data URL", () => {
    it("returns plain strings unchanged", () => {
      expect(truncateMediaUrl("hello world")).toBe("hello world");
    });

    it("returns non-media data URLs unchanged", () => {
      expect(truncateMediaUrl("data:text/plain;base64,SGVsbG8=")).toBe(
        "data:text/plain;base64,SGVsbG8="
      );
    });
  });
});

describe("truncateMediaPart", () => {
  describe("when value is AI SDK file part", () => {
    it("truncates file part with audio mediaType", () => {
      const base64 = "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibQ".repeat(50);
      const result = truncateMediaPart({
        type: "file",
        mediaType: "audio/wav",
        data: base64,
      });
      expect(result).toEqual({
        type: "file",
        mediaType: "audio/wav",
        data: `[AUDIO: audio/wav, ~${base64.length} bytes]`,
      });
    });

    it("truncates file part with video mediaType", () => {
      const base64 = "AAAAIGZ0eXBpc29t".repeat(100);
      const result = truncateMediaPart({
        type: "file",
        mediaType: "video/mp4",
        data: base64,
      });
      expect(result).toEqual({
        type: "file",
        mediaType: "video/mp4",
        data: `[VIDEO: video/mp4, ~${base64.length} bytes]`,
      });
    });
  });

  describe("when value is AI SDK image part", () => {
    it("truncates image part with data URL", () => {
      const base64 = "iVBORw0KGgoAAAANSUhEUg".repeat(100);
      const dataUrl = `data:image/png;base64,${base64}`;
      const result = truncateMediaPart({
        type: "image",
        image: dataUrl,
      });
      expect(result).toEqual({
        type: "image",
        image: `[IMAGE: image/png, ~${base64.length} bytes]`,
      });
    });

    it("truncates image part with raw base64", () => {
      const base64 = "iVBORw0KGgoAAAANSUhEUg".repeat(100);
      const result = truncateMediaPart({
        type: "image",
        image: base64,
      });
      expect(result).toEqual({
        type: "image",
        image: `[IMAGE: unknown, ~${base64.length} bytes]`,
      });
    });

    it("does not truncate short image data", () => {
      const result = truncateMediaPart({
        type: "image",
        image: "short",
      });
      expect(result).toBeNull();
    });
  });

  describe("when value is not a media part", () => {
    it("returns null for primitives", () => {
      expect(truncateMediaPart("string")).toBeNull();
      expect(truncateMediaPart(42)).toBeNull();
      expect(truncateMediaPart(null)).toBeNull();
    });

    it("returns null for arrays", () => {
      expect(truncateMediaPart([1, 2, 3])).toBeNull();
    });

    it("returns null for regular objects", () => {
      expect(truncateMediaPart({ foo: "bar" })).toBeNull();
    });

    it("returns null for incomplete file parts", () => {
      expect(truncateMediaPart({ type: "file" })).toBeNull();
      expect(truncateMediaPart({ type: "file", mediaType: "audio/wav" })).toBeNull();
    });
  });
});

