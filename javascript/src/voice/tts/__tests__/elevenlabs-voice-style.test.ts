/**
 * ElevenLabs `voiceStyle` mapping (issue #533).
 *
 * EL has no named-style field — `voiceSettings.style` is a numeric 0–1
 * exaggeration knob — so a style like `"angry"` is carried as an inline
 * paralinguistic marker on the text, which the pinned `eleven_v3` model reads
 * as a delivery instruction. These tests pin the marker actually reaching the
 * wire (`textToSpeech.convert`'s `text` field), offline via the injected
 * client factory.
 */

import { describe, it, expect, vi } from "vitest";

import { elevenLabsSynthesizeBytes } from "../elevenlabs-tts";

/**
 * Fake ElevenLabs SDK client whose `convert` records its arguments and returns
 * a single PCM frame.
 */
function makeFakeClient() {
  const convert = vi.fn(async () => {
    async function* frames() {
      yield new Uint8Array([1, 2, 3, 4]);
    }
    return frames();
  });
  return { convert, client: { textToSpeech: { convert } } };
}

describe("elevenLabsSynthesizeBytes voiceStyle → inline marker (#533)", () => {
  it("prepends the [style] marker to the text when a style is supplied", async () => {
    const { convert, client } = makeFakeClient();

    await elevenLabsSynthesizeBytes("I'm upset", "voice-id", {
      apiKey: "sk_fake",
      clientFactory: () => client as never,
      voiceStyle: "angry",
    });

    expect(convert).toHaveBeenCalledTimes(1);
    expect(convert).toHaveBeenCalledWith(
      "voice-id",
      expect.objectContaining({ text: "[angry] I'm upset" }),
    );
  });

  it("sends the bare text when no style is supplied", async () => {
    const { convert, client } = makeFakeClient();

    await elevenLabsSynthesizeBytes("I'm upset", "voice-id", {
      apiKey: "sk_fake",
      clientFactory: () => client as never,
    });

    expect(convert).toHaveBeenCalledWith(
      "voice-id",
      expect.objectContaining({ text: "I'm upset" }),
    );
  });

  it("does not double-prepend a marker the text already opens with", async () => {
    const { convert, client } = makeFakeClient();

    await elevenLabsSynthesizeBytes("[angry] I'm upset", "voice-id", {
      apiKey: "sk_fake",
      clientFactory: () => client as never,
      voiceStyle: "angry",
    });

    expect(convert).toHaveBeenCalledWith(
      "voice-id",
      expect.objectContaining({ text: "[angry] I'm upset" }),
    );
  });
});
