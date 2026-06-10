/**
 * scenario.configure() tests — global execution settings (PRD §4.7).
 *
 * The invented `configure({ stt })` provider knob was removed (ADR-002):
 * provider state is per-run via `run({ voice: { stt } })`, not a global.
 * `configure()` now carries only global *execution* settings such as
 * `audioPlayback`. These tests verify that surface.
 */
import { afterEach, describe, expect, it } from "vitest";

import { configure, getGlobalSettings } from "../configure";

describe("scenario.configure() — global execution settings", () => {
  afterEach(() => {
    // Reset the global toggle so tests stay isolated.
    configure({ audioPlayback: false });
  });

  it("sets audioPlayback so getGlobalSettings() reflects it", () => {
    configure({ audioPlayback: true });
    expect(getGlobalSettings().audioPlayback).toBe(true);
  });

  it("leaves existing settings untouched when a field is omitted", () => {
    configure({ audioPlayback: true });
    configure({}); // no fields → no change
    expect(getGlobalSettings().audioPlayback).toBe(true);
  });

  it("last write wins for audioPlayback", () => {
    configure({ audioPlayback: true });
    configure({ audioPlayback: false });
    expect(getGlobalSettings().audioPlayback).toBe(false);
  });

  it("does NOT accept an stt provider knob (removed — per-run via run({ voice }))", () => {
    // @ts-expect-error `stt` is not part of the global configure surface.
    configure({ stt: { transcribe: async () => "" } });
    // The call is a no-op for the unknown field; audioPlayback stays default.
    expect(getGlobalSettings().audioPlayback).toBeFalsy();
  });
});
