/**
 * The base URL the ElevenLabs adapter hands to the SDK.
 *
 * It is checked at construction rather than at connect, because the mistake
 * people make produces a 404 from the vendor that names no cause: the SDK
 * appends `/v1` itself, and `OPENAI_BASE_URL` conventionally includes one, so
 * a base URL copied from that habit requests `/v1/v1/convai/...`. That cost a
 * real debugging round before this check existed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ElevenLabsAgentAdapter,
  normalizeElevenLabsBaseUrl,
} from "../elevenlabs";

/** Options every `ElevenLabsClient` this file builds was constructed with. */
const clientOptions = vi.hoisted(() => [] as Record<string, unknown>[]);

// The SDK runtime is replaced so the client's own construction is observable.
// `connect()` is then allowed to fail at the Conversation, because what is
// under test is the option bag the client received, not a live session.
vi.mock("../../elevenlabs-sdk", () => ({
  loadElevenLabsConversationRuntime: () =>
    Promise.resolve({
      AudioInterface: class {},
      Conversation: class {
        constructor() {
          throw new Error("stop after the client is built");
        }
      },
      ElevenLabsClient: class {
        constructor(options: Record<string, unknown>) {
          clientOptions.push(options);
        }
      },
    }),
}));

function adapterWith(baseUrl?: string): ElevenLabsAgentAdapter {
  return new ElevenLabsAgentAdapter({
    agentId: "agent_test",
    apiKey: "key_test",
    baseUrl,
  });
}

describe("given a base URL for the ElevenLabs SDK", () => {
  beforeEach(() => {
    clientOptions.length = 0;
  });

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

describe("given the adapter builds its SDK client", () => {
  beforeEach(() => {
    clientOptions.length = 0;
  });

  it("hands a configured base URL to the client", async () => {
    // Normalizing a value it never passes on would be a check with no effect.
    await expect(
      adapterWith("https://gateway.example").connect(),
    ).rejects.toThrow();

    expect(clientOptions).toHaveLength(1);
    expect(clientOptions[0]).toMatchObject({
      apiKey: "key_test",
      baseUrl: "https://gateway.example",
    });
  });

  it("omits the option entirely when no base URL is set", async () => {
    // Passing `baseUrl: undefined` is not the same as omitting it: an
    // unconfigured adapter must send byte-for-byte what it sent before.
    await expect(adapterWith(undefined).connect()).rejects.toThrow();

    expect(clientOptions).toHaveLength(1);
    // Keys, not toEqual: an undefined property is invisible to toEqual, so
    // that assertion would pass on `baseUrl: undefined` too, which is the
    // exact thing this test exists to rule out.
    expect(Object.keys(clientOptions[0] ?? {})).toEqual(["apiKey"]);
  });
});
