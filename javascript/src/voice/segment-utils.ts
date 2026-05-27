/**
 * Pure voice-segment / timeline post-processing helpers.
 *
 * These operate purely on {@link AudioSegment}[] + {@link VoiceEvent}[] — the
 * voice-subsystem output types — so they live in the voice subtree rather than
 * coupling the execution class to it (review H1). The execution class imports
 * them at result-assembly time; tests import them directly without driving a
 * real-time run.
 *
 * The marking + latency model assumes `user_interrupt` events are timestamped
 * on the SAME byte-accurate audio cursor as the segments (see
 * `voice/adapter.runtime.ts` `layNextSegment` + the executor's interrupt
 * emission). With both on the cursor, the containment check below is a
 * like-for-like comparison rather than the cross-clock guess the wall-clock
 * timestamps produced before (review BLOCKER — issue #372).
 */

import type { AudioSegment, VoiceEvent } from "./recording.types";

/**
 * Derive `interruptResponseTime` from the voice timeline: the minimum gap
 * between a `user_interrupt` event and the next `agent_stop_speaking` (how fast
 * the agent stopped once the user barged in). Returns `undefined` when there is
 * no interrupt with a following agent stop. Mirrors the §4.6 LatencyMetrics
 * `interrupt_response_time` semantic.
 *
 * Both the `user_interrupt` time and the `agent_stop_speaking` time are on the
 * byte-accurate audio cursor, so the gap is a real duration on a single clock.
 */
export function deriveInterruptResponseTime(
  timeline: readonly VoiceEvent[],
): number | undefined {
  let best: number | undefined;
  for (let i = 0; i < timeline.length; i++) {
    if (timeline[i].type !== "user_interrupt") continue;
    const interruptTime = timeline[i].time;
    for (let j = i + 1; j < timeline.length; j++) {
      if (timeline[j].type === "agent_stop_speaking") {
        const dt = timeline[j].time - interruptTime;
        if (dt >= 0 && (best === undefined || dt < best)) best = dt;
        break;
      }
    }
  }
  return best;
}

/**
 * Mark every agent segment whose `[startTime, endTime]` span contains a
 * `user_interrupt` event as {@link AudioSegment.transcriptTruncated}: the
 * chunk-level transcript reflects the agent's INTENDED reply, not what played
 * to the user before the barge-in cut the audio. Mutates `segments` in place
 * (the recording object is shared with `result.audio`). Pure + exported so the
 * marking is unit-testable without real-time playback alignment. Mirrors Python
 * `ScenarioExecutor._attach_voice_output` (scenario_executor.py:728-740).
 *
 * Containment is inclusive on BOTH bounds (`<=`). The interrupt time is the
 * audio cursor captured at the barge-in instant, which equals the truncated
 * agent segment's `startTime` (slow transport: the segment is laid AFTER the
 * interrupt) or `endTime` (fast transport: the segment was already laid when
 * the interrupt fired). Both land exactly on a boundary, so the inclusive
 * bounds are load-bearing — an exclusive check would miss them.
 */
export function markTruncatedAgentSegments(
  segments: AudioSegment[],
  timeline: readonly VoiceEvent[],
): void {
  const interrupts = timeline.filter((e) => e.type === "user_interrupt");
  if (interrupts.length === 0) return;
  for (const seg of segments) {
    if (seg.speaker !== "agent") continue;
    for (const evt of interrupts) {
      if (seg.startTime <= evt.time && evt.time <= seg.endTime) {
        seg.transcriptTruncated = true;
        break;
      }
    }
  }
}
