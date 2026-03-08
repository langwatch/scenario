/**
 * Discriminated union of streaming parts emitted by an agent's `stream()` method.
 *
 * Agents that support streaming yield these parts to provide granular
 * text and tool-call progress to the execution layer.
 */
export type AgentStreamPart =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call-start"; toolCallId: string; toolCallName: string }
  | { type: "tool-call-delta"; toolCallId: string; delta: string }
  | {
      type: "tool-call-end";
      toolCallId: string;
      toolCallName: string;
      args: unknown;
    };
