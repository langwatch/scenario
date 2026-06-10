/**
 * AC-JS5 / AC-JS7 (formatter arm) — transcript surfacing + degraded-transcript
 * safety for the realtime adapter's `ResponseFormatter`.
 *
 * Context (issue #623): the realtime adapter surfaces a voiced agent turn as a
 * two-part assistant message —
 *   [{ type: "text", text: transcript }, { type: "file", mediaType: "audio/pcm16", ... }]
 * The `text` part is what the user simulator reads (and, pre-fix, parroted back
 * as an echo). Two properties must hold at this formatter boundary:
 *
 *  - AC-JS5: a REAL transcript is surfaced verbatim as the `text` part, riding
 *    alongside the `audio/pcm16` `file` part. This is the surface the whole
 *    echo chain depends on — if the transcript were dropped here, there would
 *    be nothing to (mis)read downstream.
 *  - AC-JS7 (formatter arm): a DEGRADED transcript (empty string or undefined —
 *    silence, dropped ASR) must NOT produce a `text: undefined` part nor the
 *    literal string `"undefined"`. The formatter either omits the text part or
 *    emits an empty string. (The production guard added for #623 omits it.)
 *
 * Pure-function unit assertions — no run-shape, no creds, no transport.
 */

import { describe, it, expect } from "vitest";

import { ResponseFormatter } from "../realtime/response-formatter";
import type { AudioResponseEvent } from "../realtime/realtime-event-handler";

/** Minimal base64 PCM16 stand-in (bytes are irrelevant to these assertions). */
const AUDIO_B64 = Buffer.from("\x00\x00".repeat(8), "binary").toString("base64");

interface TextPart {
  type: "text";
  text: string;
}
interface FilePart {
  type: "file";
  mediaType: string;
  data: string;
}
type Part = TextPart | FilePart | { type?: string; [k: string]: unknown };

function partsOf(msg: { content: unknown }): Part[] {
  expect(Array.isArray(msg.content)).toBe(true);
  return msg.content as Part[];
}
function textParts(parts: Part[]): TextPart[] {
  return parts.filter((p): p is TextPart => p.type === "text");
}
function filePart(parts: Part[]): FilePart | undefined {
  return parts.find((p): p is FilePart => p.type === "file");
}

describe("ResponseFormatter.formatAudioResponse — transcript surfacing (AC-JS5)", () => {
  it("surfaces a real transcript as a text part alongside an audio/pcm16 file part", () => {
    const transcript = "what was your role on the payments team";
    const event: AudioResponseEvent = { transcript, audio: AUDIO_B64 };

    const msg = new ResponseFormatter().formatAudioResponse(event);
    expect(msg.role).toBe("assistant");

    const parts = partsOf(msg);

    // Exactly one text part, carrying the transcript VERBATIM (=== the event's
    // transcript — this is the value the echo chain reads downstream).
    const texts = textParts(parts);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toBe(transcript);
    expect(texts[0]!.text).toBe(event.transcript);

    // The audio rides alongside as a pcm16 file part with the same bytes.
    const file = filePart(parts);
    expect(file).toBeDefined();
    expect(file!.mediaType).toBe("audio/pcm16");
    expect(file!.data).toBe(AUDIO_B64);

    // formatInitialResponse is the agent-first entry; same surfaced shape.
    const initial = new ResponseFormatter().formatInitialResponse(event);
    const initialTexts = textParts(partsOf(initial));
    expect(initialTexts).toHaveLength(1);
    expect(initialTexts[0]!.text).toBe(transcript);
  });
});

describe("ResponseFormatter.formatAudioResponse — degraded transcript (AC-JS7, formatter arm)", () => {
  // Both degraded shapes a live RealtimeEventHandler can hand the formatter:
  //   ""        — handler initialises currentResponse = "" and no delta arrived
  //   undefined — a malformed / partial event with no transcript field
  const degraded: Array<[string, string | undefined]> = [
    ["empty string", ""],
    ["undefined", undefined],
  ];

  it.each(degraded)(
    "never emits text:undefined or the literal \"undefined\" for a %s transcript",
    (_label, transcript) => {
      const event = {
        transcript,
        audio: AUDIO_B64,
      } as unknown as AudioResponseEvent;

      const msg = new ResponseFormatter().formatAudioResponse(event);
      const parts = partsOf(msg);

      // The audio is ALWAYS surfaced — a degraded transcript never drops audio.
      const file = filePart(parts);
      expect(file).toBeDefined();
      expect(file!.mediaType).toBe("audio/pcm16");
      expect(file!.data).toBe(AUDIO_B64);

      // Contract: omit the text part OR emit an empty string — but NEVER a
      // `text: undefined` part and NEVER the literal "undefined".
      const texts = textParts(parts);
      for (const t of texts) {
        expect(t.text).not.toBeUndefined();
        expect(t.text).not.toBe("undefined");
        expect(t.text).toBe(""); // if a text part survives, it must be empty
      }
      // And the serialized form (what an LLM/transport would see) must not
      // carry the literal "undefined" anywhere in the text channel.
      const serialized = JSON.stringify(parts);
      expect(serialized).not.toContain('"text":"undefined"');
      expect(serialized).not.toContain('"text":undefined');
    },
  );
});
