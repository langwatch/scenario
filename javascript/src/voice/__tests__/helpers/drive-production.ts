/**
 * Wrapper-level test harness for voice adapters — the tier-1 seam that drives
 * an agent turn through the REAL production `adapter.call()` wrapper. JS
 * mirror of `python/scenario/voice/testing/wrapper_harness.py`.
 *
 * WHY wrapper-level (not seam-level) tests are load-bearing: PR #697's P0 hid
 * because the seam tests drove adapter internals *by name* while production
 * crashed in the wrapper that wires those internals together. A wrapper-level
 * test stubs nothing between the test and the adapter's outermost production
 * entry point, so a fix (or a regression) that only manifests on the real
 * `call()` / `connect()` flow cannot hide behind a test seam.
 *
 * Vendor transports should be faked at the NETWORK CLIENT boundary (an
 * in-process `ws` server, a scripted `MediaStreamWebSocket`), never by
 * assigning adapter privates — that private-poke seam is exactly what this
 * harness exists to avoid.
 */

import { AgentRole, type AgentInput } from "../../../domain/agents";
import type { AgentReturnTypes } from "../../../domain/agents/types/agent-return.types";
import type { VoiceAgentAdapter } from "../../adapter";
import type { TwilioAgentAdapter } from "../../adapters/twilio";
import type { MediaStreamWebSocket } from "../../adapters/twilio-server";
import type { AudioChunk } from "../../audio-chunk";
import { createAudioMessage } from "../../messages";

/**
 * Build the minimal {@link AgentInput} that {@link driveCall} feeds the real
 * `call()`.
 *
 * With `userAudio`, the input carries one user audio message so the real
 * `sendAudio` edge runs; without it, `call()` is an agent-initiated turn that
 * goes straight to the drain. Carries no scenario state, so segment recording
 * degrades to a no-op (mirrors Python's `make_agent_input`).
 */
export function makeAgentInput(userAudio?: AudioChunk): AgentInput {
  const newMessages = userAudio ? [createAudioMessage(userAudio, "user")] : [];
  return {
    threadId: "wrapper-harness",
    messages: [...newMessages],
    newMessages,
    requestedRole: AgentRole.AGENT,
    scenarioState: {} as AgentInput["scenarioState"],
    scenarioConfig: {} as AgentInput["scenarioConfig"],
  };
}

/**
 * Drive one agent turn through the REAL production wrapper — `adapter.call()`.
 *
 * This is the generic tier-1 entry for wrapper-level adapter tests: nothing
 * between the test and the adapter's outermost production entry point is
 * stubbed, so a fix (or a regression) that only manifests on the real `call()`
 * flow — sendAudio framing, drain loop, transcript attachment — cannot hide
 * behind a test seam. (The bug class that hid PR #697's P0: tests drove
 * internals by name while production crashed in the wrapper that wires them
 * together.)
 *
 * NOT covered: segment recording. {@link makeAgentInput} carries an empty
 * `scenarioState`, so the recorder degrades to a no-op. Pass an input carrying
 * a real `scenarioState` if the recorder timeline is what you mean to exercise.
 */
export async function driveCall(
  adapter: VoiceAgentAdapter,
  input?: AgentInput,
): Promise<AgentReturnTypes> {
  return adapter.call(input ?? makeAgentInput());
}

/**
 * Run the Twilio production per-connection wrapper
 * (`TwilioWebhookServer.runStreamSession` — what the real `/twilio/stream`
 * route delegates to) to its terminal over the given socket double. JS mirror
 * of Python's `drive_twilio_production`.
 *
 * On return, the adapter's stream transport/SID have been nulled by the
 * wrapper's `finally` — exactly as in production after a call ends. Used for
 * the terminations a real socket cannot produce (a `receiveText` that rejects
 * with a non-disconnect error; a second session on the same connected
 * adapter).
 */
export async function driveTwilioProduction(
  adapter: TwilioAgentAdapter,
  ws: MediaStreamWebSocket,
): Promise<void> {
  await adapter._driveStreamSession(ws);
}
