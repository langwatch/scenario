/**
 * Custom effect wrapper — users provide an arbitrary Uint8Array → Uint8Array function.
 *
 * TS equivalent of `python/scenario/voice/effects/custom.py`.
 */

import { EffectFn } from "./common";

/**
 * Wrap a user-supplied `fn(audioPcm16) -> audioPcm16`.
 *
 * Validates that:
 * 1. `fn` is callable (throws TypeError if not).
 * 2. `fn` returns a `Uint8Array` (throws TypeError at call-time if not).
 */
export function custom(fn: EffectFn): EffectFn {
  if (typeof fn !== "function") {
    throw new TypeError("custom() requires a callable that takes and returns bytes");
  }

  return function _apply(audio: Uint8Array): Uint8Array {
    const result = fn(audio);
    if (!(result instanceof Uint8Array)) {
      throw new TypeError("custom effect function must return bytes");
    }
    return result;
  };
}
