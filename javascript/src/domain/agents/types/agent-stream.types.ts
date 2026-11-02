/**
 * The parts of an AI SDK `streamText(...).fullStream` that a run reports live.
 * Each is a structural subset of the AI SDK part of the same `type`, so a real
 * part can be written as it is. A step is one assistant message.
 */
export type AgentStreamPart =
  | { type: "start-step" }
  | { type: "finish-step" }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; text: string }
  | { type: "text-end"; id: string }
  | { type: "tool-input-start"; id: string; toolName: string }
  | { type: "tool-input-delta"; id: string; delta: string }
  | { type: "tool-input-end"; id: string };

/**
 * Where an agent reports its output live while `call()` runs. Present on
 * {@link AgentInput.stream} only when the run sends granular events and the
 * agent plays the user or the agent under test; an agent that ignores it is
 * reported once its call returns.
 *
 * What `call()` returns stays the message the run records: the stream only
 * shows progress, and the returned messages replace it.
 *
 * @example
 * ```typescript
 * async call(input: AgentInput) {
 *   const result = streamText({ model, messages: input.messages });
 *   if (input.stream) await input.stream.pipe(result.fullStream);
 *   return (await result.response).messages;
 * }
 * ```
 */
export interface AgentStreamWriter {
  /**
   * Reports one part. Never throws, and a part written after the call
   * settled is ignored: the caller owns its failures and throws from
   * `call()` itself when its source fails.
   */
  write(part: AgentStreamPart): void;
  /**
   * Reads a whole AI SDK `fullStream` once, reporting the parts it knows and
   * skipping the rest. Rejects when the stream throws, and also on an
   * `error` part (with that part's error) or an `abort` part (an Error named
   * "AbortError"), which the AI SDK yields instead of throwing; so a failed
   * stream fails the call rather than passing for a short answer.
   */
  pipe(stream: AsyncIterable<{ type: string }>): Promise<void>;
}
