/**
 * Where the agent shapes are reachable from, pinned.
 *
 * `agent-shapes.ts` moved from `voice/` to `domain/agents/` for #579, and the
 * move left a `@deprecated` re-export shim at the old path so nothing had to
 * change. Removing that shim is only safe while the names it forwarded stay
 * exported from the paths callers actually import, and both of those paths are
 * public: the package's root index does `export * from "./domain"` and
 * `export * as voice from "./voice"`, so anything reachable through either is
 * published API of `@langwatch/scenario`.
 *
 * Nothing asserted that before. The shim's presence was the only thing making
 * the old import path work, and its absence would have been a silent breaking
 * change for any consumer importing from the `voice` namespace. So this file
 * asserts the surface rather than the implementation: it does not care where
 * the declarations live, only that both entry points still carry them.
 */

import { describe, expect, it } from "vitest";

import * as voice from "../../../voice/index";
import * as domainAgents from "../index";

/**
 * The two runtime names the removed shim forwarded. It forwarded five in all;
 * the other three are types, and a runtime assertion cannot see an erased type.
 * The type surface is pinned separately, at compile time, further down.
 *
 * A rename or a dropped export in a future move fails here rather than in a
 * consumer's build.
 */
const FORWARDED_VALUES = ["isRealtimeUserAgent", "isVoiceUserSim"] as const;

describe("the agent shapes, after moving to the domain layer", () => {
  describe("when imported through the voice namespace, as a consumer would", () => {
    it.each(FORWARDED_VALUES)("still exports %s", (name) => {
      expect(typeof (voice as Record<string, unknown>)[name]).toBe("function");
    });

    /**
     * The guards are the reason the types are worth exporting: a consumer
     * narrows with the guard and then holds the narrowed shape. Asserting the
     * guard behaves proves the export is the real one and not a stub that
     * happens to be a function.
     */
    it("exports a working isVoiceUserSim, not merely a function of that name", () => {
      expect(
        voice.isVoiceUserSim({
          voice: "alloy",
          voiceifyText: async () => ({ role: "user", content: "" }),
        }),
      ).toBe(true);
      // A voice channel is configured only when the voice is a non-empty
      // string; this is the case the structural check exists for.
      expect(
        voice.isVoiceUserSim({ voice: "", voiceifyText: async () => ({}) }),
      ).toBe(false);
    });

    it("exports a working isRealtimeUserAgent", () => {
      expect(
        voice.isRealtimeUserAgent({
          sendText: () => undefined,
          speakUserTurn: () => undefined,
        }),
      ).toBe(true);
      // Both members are required: the executor routes scripted user turns
      // through `speakUserTurn`.
      expect(voice.isRealtimeUserAgent({ sendText: () => undefined })).toBe(
        false,
      );
    });
  });

  describe("when imported through the domain namespace, which is the canonical path", () => {
    it.each(FORWARDED_VALUES)("exports %s", (name) => {
      expect(typeof (domainAgents as Record<string, unknown>)[name]).toBe(
        "function",
      );
    });

    it("is the same binding the voice namespace re-exports, not a second copy", () => {
      expect(voice.isVoiceUserSim).toBe(domainAgents.isVoiceUserSim);
      expect(voice.isRealtimeUserAgent).toBe(domainAgents.isRealtimeUserAgent);
    });
  });

  /**
   * The types the shim forwarded, pinned at compile time.
   *
   * The assertions above reach only the two guards, because a type is erased
   * before any test can look at it. The annotations below do reach them: drop a
   * type export from either path and this file stops compiling, which surfaces
   * the break on the branch that caused it rather than in a consumer's build.
   *
   * Both entry points carry the same two types, so both lists are the same.
   */
  describe("when the erased type exports are what a consumer depends on", () => {
    it("still types both shapes on the voice path", () => {
      const realtime: voice.RealtimeUserAgent = {
        sendText: async () => undefined,
        speakUserTurn: async () => ({ data: new Uint8Array(), transcript: "" }),
      };
      const sim: voice.VoiceUserSimulator = {
        voice: "alloy",
        voiceifyText: async () => ({ role: "user", content: "" }),
      };

      // A guard whose narrowed type the value already carries must accept it.
      // That is what ties the type export to the runtime export: either one
      // going missing on its own breaks this.
      expect(voice.isRealtimeUserAgent(realtime)).toBe(true);
      expect(voice.isVoiceUserSim(sim)).toBe(true);
    });

    it("still types both shapes on the domain path, which is the canonical one", () => {
      const realtime: domainAgents.RealtimeUserAgent = {
        sendText: async () => undefined,
        speakUserTurn: async () => ({ data: new Uint8Array() }),
      };
      const sim: domainAgents.VoiceUserSimulator = {
        voice: "alloy",
        voiceifyText: async () => ({ role: "user", content: "" }),
      };

      expect(domainAgents.isRealtimeUserAgent(realtime)).toBe(true);
      expect(domainAgents.isVoiceUserSim(sim)).toBe(true);
    });
  });
});
