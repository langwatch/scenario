/**
 * A connected agent function as a scenario agent.
 *
 * `connectAgent` from the LangWatch SDK returns a function that is still
 * directly callable with the turn fields of the connected agent contract:
 * `messages`, `newMessages`, `threadId`, `session`, `params` and `traceId`.
 * This module wraps it into an {@link AgentAdapter}, so
 * `scenario.run({ agents: [...] })` accepts it directly and the local test
 * and the platform run share one piece of code for the agent.
 *
 * @see specs/connected-agent-adapter.feature
 */
import type { ModelMessage } from "ai";
import {
  AgentAdapter,
  AgentRole,
  isConnectedAgent,
  type AgentInput,
  type AgentReturnTypes,
  type ConnectedAgentCall,
  type ConnectedAgentFunction,
  type ConnectedAgentParameterValue,
} from "../domain";

/** The trace id of a W3C `traceparent` header, empty when there is none. */
export function traceIdFromHeaders(headers: Record<string, string> | undefined): string {
  const traceparent = headers?.traceparent;
  if (typeof traceparent !== "string") return "";
  const parts = traceparent.split("-");
  return parts.length >= 3 && parts[1]?.length === 32 ? parts[1] : "";
}

const isMessage = (value: unknown): value is ModelMessage =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as { role?: unknown }).role === "string";

/**
 * The output and the session of one reply. Accepts a string, one message, a
 * list of messages, or `{ output, session }`. The session is `undefined`
 * when the reply carries none.
 */
export function readReply(reply: unknown): { output: AgentReturnTypes; session: unknown } {
  let output: unknown = reply;
  let session: unknown = undefined;
  if (typeof reply === "object" && reply !== null && !Array.isArray(reply) && "output" in reply) {
    const wrapped = reply as { output: unknown; session?: unknown };
    output = wrapped.output;
    session = wrapped.session;
  }
  if (output === null || output === undefined) return { output: "", session };
  if (typeof output === "string") return { output, session };
  if (Array.isArray(output)) return { output: output.filter(isMessage), session };
  if (isMessage(output)) return { output, session };
  return { output: String(output), session };
}

/**
 * Runs a connected agent function as the agent under test.
 *
 * Builds the connected call from the scenario's {@link AgentInput}, keeps the
 * `session` the function returns per thread, and sends it back on the next
 * turn of the same thread, the same echo the platform does.
 */
export class ConnectedAgentAdapter implements AgentAdapter {
  readonly name: string;
  readonly role = AgentRole.AGENT;
  readonly parameters: Record<string, ConnectedAgentParameterValue>;
  private readonly sessions = new Map<string, unknown>();

  constructor(
    readonly agent: ConnectedAgentFunction,
    parameters?: Record<string, ConnectedAgentParameterValue>,
  ) {
    if (!isConnectedAgent(agent)) {
      throw new Error(
        "ConnectedAgentAdapter expects the function connectAgent returns: a function with a name and an environment",
      );
    }
    this.name = agent.name;
    this.parameters = { ...parameters };
  }

  /** The session held for a thread, `undefined` before the first reply. */
  sessionFor(threadId: string): unknown {
    return this.sessions.get(threadId);
  }

  async call(input: AgentInput): Promise<AgentReturnTypes> {
    const call: ConnectedAgentCall = {
      messages: [...input.messages],
      newMessages: [...input.newMessages],
      threadId: input.threadId,
      session: this.sessions.get(input.threadId) ?? null,
      params: { ...this.parameters },
      traceId: traceIdFromHeaders(input.propagationHeaders),
    };
    const invoke = this.agent as unknown as (call: ConnectedAgentCall) => unknown;
    const { output, session } = readReply(await invoke(call));
    if (session !== undefined) {
      this.sessions.set(input.threadId, session);
    }
    return output;
  }
}

/** Every connected agent function wrapped, every adapter as is. */
export function resolveAgents(
  agents: ReadonlyArray<AgentAdapter | ConnectedAgentFunction>,
  parameters?: Record<string, ConnectedAgentParameterValue>,
): AgentAdapter[] {
  return agents.map((agent) =>
    isConnectedAgent(agent) ? new ConnectedAgentAdapter(agent, parameters) : agent,
  );
}
