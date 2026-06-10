/**
 * Factory unit tests for userSimulatorAgent.
 *
 * Covers constructor-time configuration and property exposure; no
 * interrupt-flow execution is exercised here. Moved from
 * execution/__tests__/proceed-interruptions.test.ts (#582 hygiene).
 */

import { describe, it, expect } from "vitest";

import { userSimulatorAgent } from "../user-simulator-agent";

describe("userSimulatorAgent factory", () => {
  it("userSimulatorAgent({ interruptProbability }) exposes the value", () => {
    const sim = userSimulatorAgent({ interruptProbability: 0.4 });
    expect(
      (sim as unknown as { interruptProbability: number }).interruptProbability,
    ).toBe(0.4);
  });
});
