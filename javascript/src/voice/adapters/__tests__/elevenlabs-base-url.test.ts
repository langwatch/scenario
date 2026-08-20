/**
 * The base URL the ElevenLabs adapter hands to the SDK.
 *
 * It is checked at construction rather than at connect, because the mistake
 * people make produces a 404 from the vendor that names no cause: the SDK
 * appends `/v1` itself, and `OPENAI_BASE_URL` conventionally includes one, so
 * a base URL copied from that habit requests `/v1/v1/convai/...`. That cost a
 * real debugging round before this check existed.
 */

import { describe, expect, it } from "vitest";

import {
  ElevenLabsAgentAdapter,
  normalizeElevenLabsBaseUrl,
} from "../elevenlabs";

function adapterWith(baseUrl?: string): ElevenLabsAgentAdapter {
  return new ElevenLabsAgentAdapter({
    agentId: "agent_test",
    apiKey: "key_test",
    baseUrl,
  });
}

describe("given a base URL for the ElevenLabs SDK", () => {
  describe("when it carries the /v1 prefix", () => {
    it("refuses it, naming the doubling it would produce", () => {
      expect(() => adapterWith("https://gateway.example/v1")).toThrow(/\/v1\/v1/);
    });

    it("refuses it with a trailing slash too", () => {
      expect(() => adapterWith("https://gateway.example/v1/")).toThrow(
        /must not include \/v1/,
      );
    });
  });

  describe("when it is not a URL", () => {
    it("refuses it at construction rather than at the first request", () => {
      expect(() => adapterWith("gateway.example")).toThrow(/is not a URL/);
    });
  });

  describe("when its scheme is not http or https", () => {
    it("refuses it, because the SDK cannot make a REST request over it", () => {
      // `new URL` parses these, so parsing alone is not a check.
      expect(() => adapterWith("ftp://gateway.example")).toThrow(
        /must be http or https/,
      );
      expect(() => adapterWith("file:///tmp/gateway")).toThrow(
        /must be http or https/,
      );
    });
  });

  describe("when it names a host root", () => {
    it("keeps it, with any trailing slash removed", () => {
      expect(normalizeElevenLabsBaseUrl("https://gateway.example/")).toBe(
        "https://gateway.example",
      );
      expect(() => adapterWith("https://gateway.example/")).not.toThrow();
    });
  });

  describe("when it is absent or empty", () => {
    it("leaves the SDK on its own default", () => {
      // Empty is unset, not an error: it is what an unset environment
      // variable spreads into an options object as.
      expect(normalizeElevenLabsBaseUrl(undefined)).toBeUndefined();
      expect(normalizeElevenLabsBaseUrl("   ")).toBeUndefined();
    });
  });
});
