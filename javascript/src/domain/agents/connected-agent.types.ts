/**
 * The shape `connectAgent` from the LangWatch SDK returns, as `scenario.run`
 * accepts it. Types only: nothing here imports the SDK, the accept is duck
 * typed on `name` and `environment`.
 *
 * @see specs/connected-agent-adapter.feature
 */
import type { ModelMessage } from "ai";

/** The value of one run parameter. */
export type ConnectedAgentParameterValue = string | number | boolean;

/** One turn as the connected agent contract sends it. */
export interface ConnectedAgentCall {
  /** The full conversation. */
  messages: ModelMessage[];
  /** The messages added since the last turn of this thread. */
  newMessages: ModelMessage[];
  /** The scenario thread id. */
  threadId: string;
  /** The session the function returned on the previous turn of this thread, null on the first. */
  session: unknown;
  /** The run parameters the scenario sets. A parameter not set here takes the function default. */
  params: Record<string, ConnectedAgentParameterValue>;
  /** The trace id of the current turn, empty when no span is active. */
  traceId: string;
}

/** What the function may return: a string, one message, or a list of messages. */
export type ConnectedAgentOutput = string | ModelMessage | ModelMessage[];

/** The output of one turn plus the session the function keeps for the next turn of the thread. */
export interface ConnectedAgentReply {
  output: ConnectedAgentOutput;
  session?: unknown;
}

/**
 * The decorated function: callable with a {@link ConnectedAgentCall}, with a
 * `name` and an `environment`. The call signature is left open because the
 * SDK types the call by the parameters the agent declares.
 */
export interface ConnectedAgentFunction {
  (...args: never[]): unknown;
  readonly name: string;
  readonly environment: string;
}

/** True for a function with a string `name` and a string `environment`. */
export function isConnectedAgent(value: unknown): value is ConnectedAgentFunction {
  if (typeof value !== "function") return false;
  const candidate = value as { name?: unknown; environment?: unknown };
  return typeof candidate.name === "string" && typeof candidate.environment === "string";
}
