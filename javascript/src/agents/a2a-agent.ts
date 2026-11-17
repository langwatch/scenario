/**
 * An A2A agent as the agent under test, built from its Agent Card URL.
 * Each turn is an A2A `SendMessage` with one `contextId` per scenario thread,
 * carrying the W3C trace context of a client span.
 * See specs/a2a-agent-adapter.feature and https://a2a-protocol.org/latest/specification/.
 */
import { randomUUID } from "node:crypto";
import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { AgentAdapter, AgentRole, type AgentInput, type AgentReturnTypes } from "../domain";

export const A2A_PROTOCOL_VERSION = "1.0";
const SUPPORTED_BINDINGS = ["JSONRPC", "HTTP+JSON"] as const;
const FAILED_STATES = ["failed", "rejected", "canceled", "auth_required"];

/** The a2a.* names follow open-telemetry/semantic-conventions-genai#254 and are not stable yet. */
export const A2A_ATTRIBUTES = {
  agentName: "gen_ai.agent.name",
  operation: "gen_ai.operation.name",
  binding: "a2a.protocol.binding",
  version: "a2a.protocol.version",
  method: "a2a.method",
  contextId: "a2a.context.id",
  taskId: "a2a.task.id",
  taskState: "a2a.task.state",
  messageId: "a2a.message.id",
} as const;

type Part = { text?: string };
type A2AMessage = { messageId?: string; contextId?: string; role?: string; parts?: Part[] };
type A2ATask = {
  id?: string;
  contextId?: string;
  status?: { state?: string; message?: A2AMessage };
  artifacts?: { parts?: Part[] }[];
};
type SendMessageResult = { task?: A2ATask; message?: A2AMessage };
type AgentInterface = { url: string; protocolBinding: string; protocolVersion?: string };
export type AgentCard = {
  name?: string;
  url?: string;
  supportedInterfaces?: AgentInterface[];
  [key: string]: unknown;
};

/** An A2A agent refused or failed a turn. */
export class A2AError extends Error {
  override name = "A2AError";
}

export interface A2AAgentOptions {
  /** URL of the Agent Card, usually `https://host/.well-known/agent-card.json`. */
  cardUrl: string;
  /** A bearer token, or headers sent on the card fetch and on every request. */
  auth?: string | Record<string, string>;
  /** Timeout for the card fetch and each request, in milliseconds. Defaults to 120000. */
  timeoutMs?: number;
}

const partsText = (message?: { parts?: Part[] }): string =>
  (message?.parts ?? []).flatMap((p) => (typeof p.text === "string" ? [p.text] : [])).join("\n");

const taskState = (task: A2ATask): string =>
  (task.status?.state ?? "").replace(/^TASK_STATE_/, "").toLowerCase().replace(/-/g, "_");

function replyText(result: SendMessageResult): string {
  if (result.message) return partsText(result.message);
  const task = result.task ?? {};
  const texts = [...(task.artifacts ?? []).map(partsText), partsText(task.status?.message)];
  return texts.filter(Boolean).join("\n");
}

function lastUserText(input: AgentInput): string {
  const messages = input.newMessages.length > 0 ? input.newMessages : input.messages;
  for (const message of [...messages].reverse()) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content
      .map((p) => ("text" in p && typeof p.text === "string" ? p.text : ""))
      .join("\n");
  }
  return "";
}

/** Runs any A2A agent as the agent under test, from its Agent Card URL. */
export class A2AAgent extends AgentAdapter {
  override name = "A2AAgent";
  override role = AgentRole.AGENT;
  readonly cardUrl: string;
  card?: AgentCard;
  private readonly authHeaders: Record<string, string>;
  private readonly contexts = new Map<string, string>();
  private readonly openTasks = new Map<string, string>();
  private readonly timeoutMs: number;

  constructor({ cardUrl, auth, timeoutMs = 120_000 }: A2AAgentOptions) {
    super();
    this.cardUrl = cardUrl;
    this.timeoutMs = timeoutMs;
    this.authHeaders = typeof auth === "string" ? { Authorization: `Bearer ${auth}` } : { ...auth };
  }

  private async loadCard(): Promise<AgentCard> {
    if (!this.card) {
      const response = await fetch(this.cardUrl, {
        headers: this.authHeaders,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new A2AError(`Agent Card fetch failed with HTTP ${response.status}`);
      this.card = (await response.json()) as AgentCard;
      this.name = this.card.name ?? "A2AAgent";
    }
    return this.card;
  }

  private pickInterface(card: AgentCard): AgentInterface {
    const listed = card.supportedInterfaces ?? [];
    const interfaces =
      listed.length > 0 ? listed : card.url ? [{ url: card.url, protocolBinding: "JSONRPC" }] : [];
    const found = interfaces.find((i) =>
      (SUPPORTED_BINDINGS as readonly string[]).includes(i.protocolBinding),
    );
    if (found) return found;
    throw new A2AError(
      `The Agent Card at ${this.cardUrl} lists no supported interface (found ${JSON.stringify(
        interfaces.map((i) => i.protocolBinding),
      )}); A2AAgent supports ${JSON.stringify(SUPPORTED_BINDINGS)}.`,
    );
  }

  private async post(
    iface: AgentInterface,
    request: { message: A2AMessage & { taskId?: string } },
    headers: Record<string, string>,
  ): Promise<SendMessageResult> {
    const isRest = iface.protocolBinding === "HTTP+JSON";
    const url = isRest ? `${iface.url.replace(/\/$/, "")}/message:send` : iface.url;
    const body = isRest
      ? request
      : { jsonrpc: "2.0", id: randomUUID(), method: "SendMessage", params: request };
    const response = await fetch(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new A2AError(`A2A agent answered HTTP ${response.status}`);
    const payload = (await response.json()) as {
      result?: SendMessageResult;
      error?: { code?: number; message?: string };
    } & SendMessageResult;
    if (isRest) return payload;
    if (payload.error) {
      throw new A2AError(
        `A2A agent returned JSON-RPC error ${payload.error.code}: ${payload.error.message}`,
      );
    }
    return payload.result ?? {};
  }

  async call(input: AgentInput): Promise<AgentReturnTypes> {
    const card = await this.loadCard();
    const iface = this.pickInterface(card);
    const contextId = this.contexts.get(input.threadId) ?? randomUUID();
    this.contexts.set(input.threadId, contextId);
    const message: A2AMessage & { taskId?: string } = {
      messageId: randomUUID(),
      contextId,
      role: "ROLE_USER",
      parts: [{ text: lastUserText(input) }],
    };
    const openTask = this.openTasks.get(input.threadId);
    if (openTask) {
      message.taskId = openTask;
      this.openTasks.delete(input.threadId);
    }

    const tracer = trace.getTracer("scenario.a2a");
    return tracer.startActiveSpan(
      `invoke_agent ${this.name}`,
      { kind: SpanKind.CLIENT },
      async (span) => {
        try {
          span.setAttributes({
            [A2A_ATTRIBUTES.operation]: "invoke_agent",
            [A2A_ATTRIBUTES.agentName]: this.name,
            [A2A_ATTRIBUTES.binding]: iface.protocolBinding,
            [A2A_ATTRIBUTES.version]: A2A_PROTOCOL_VERSION,
            [A2A_ATTRIBUTES.method]: "SendMessage",
            [A2A_ATTRIBUTES.contextId]: contextId,
            [A2A_ATTRIBUTES.messageId]: message.messageId ?? "",
            "server.address": new URL(iface.url).hostname,
          });
          const headers: Record<string, string> = {
            ...this.authHeaders,
            "A2A-Version": A2A_PROTOCOL_VERSION,
          };
          propagation.inject(context.active(), headers);
          const result = await this.post(iface, { message }, headers);
          const replyContext = result.task?.contextId ?? result.message?.contextId;
          if (replyContext) this.contexts.set(input.threadId, replyContext);
          if (result.task) {
            const state = taskState(result.task);
            span.setAttributes({
              [A2A_ATTRIBUTES.taskId]: result.task.id ?? "",
              [A2A_ATTRIBUTES.taskState]: state,
            });
            if (FAILED_STATES.includes(state)) {
              throw new A2AError(
                `A2A task ${result.task.id} ended in state ${state}: ${partsText(result.task.status?.message)}`,
              );
            }
            if (state === "input_required" && result.task.id) {
              this.openTasks.set(input.threadId, result.task.id);
            }
          }
          return replyText(result);
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }
}
