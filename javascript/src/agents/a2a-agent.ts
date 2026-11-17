/**
 * An A2A v1.0 agent as the agent under test, built from its Agent Card URL.
 * Each turn is an A2A `SendMessage` with one `contextId` per scenario thread,
 * carrying the W3C trace context of a client span.
 * See specs/a2a-agent-adapter.feature and https://a2a-protocol.org/latest/specification/.
 */
import { randomUUID } from "node:crypto";
import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { z } from "zod";
import { AgentAdapter, AgentRole, type AgentInput, type AgentReturnTypes } from "../domain";

export const A2A_PROTOCOL_VERSION = "1.0";
const SUPPORTED_BINDINGS = ["JSONRPC", "HTTP+JSON"] as const;
const DONE_STATES = ["completed", "input_required"];
const PENDING_STATES = ["submitted", "working", "unspecified", ""];
const MAX_REDIRECTS = 5;

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

const partSchema = z.object({ text: z.unknown().optional() }).passthrough();
const messageSchema = z
  .object({ contextId: z.string().nullish(), parts: z.array(partSchema).nullish() })
  .passthrough();
const taskSchema = z
  .object({
    id: z.string().nullish(),
    contextId: z.string().nullish(),
    status: z
      .object({ state: z.string().nullish(), message: messageSchema.nullish() })
      .passthrough()
      .nullish(),
    artifacts: z.array(z.object({ parts: z.array(partSchema).nullish() }).passthrough()).nullish(),
  })
  .passthrough();
const sendMessageResultSchema = z
  .object({ task: taskSchema.nullish(), message: messageSchema.nullish() })
  .passthrough();
const interfaceSchema = z
  .object({
    url: z.string(),
    protocolBinding: z.string(),
    protocolVersion: z.string().nullish(),
    tenant: z.string().nullish(),
  })
  .passthrough();
const agentCardSchema = z
  .object({
    name: z.string().nullish(),
    protocolVersion: z.string().nullish(),
    preferredTransport: z.string().nullish(),
    supportedInterfaces: z.array(z.unknown()).nullish(),
  })
  .passthrough();
const jsonRpcResponseSchema = z
  .object({
    result: z.unknown().optional(),
    error: z.object({ code: z.unknown(), message: z.unknown() }).partial().passthrough().nullish(),
  })
  .passthrough();

type A2AMessage = { messageId: string; contextId: string; role: string; parts: { text: string }[]; taskId?: string };
type A2ATask = z.infer<typeof taskSchema>;
type AgentInterface = z.infer<typeof interfaceSchema>;
export type AgentCard = z.infer<typeof agentCardSchema>;

/** An A2A agent refused or failed a turn, or could not be reached. */
export class A2AError extends Error {
  override name = "A2AError";

  /** The agent no longer knows the task the turn continued, for example after it expired. */
  readonly taskNotFound: boolean;

  constructor(message: string, options: { taskNotFound?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.taskNotFound = options.taskNotFound ?? false;
  }
}

const TASK_NOT_FOUND_CODE = -32001;

/** An HTTP+JSON 404 means task-not-found only when its ErrorInfo says so. */
async function isRestTaskNotFound(response: Response): Promise<boolean> {
  const payload = (await response.json().catch(() => undefined)) as
    | { error?: { details?: { reason?: string; domain?: string }[] } }
    | undefined;
  const details = payload?.error?.details;
  return (
    Array.isArray(details) &&
    details.some((d) => d?.reason === "TASK_NOT_FOUND" && d?.domain === "a2a-protocol.org")
  );
}

async function parseBody<T>(response: Response, schema: z.ZodType<T>, what: string): Promise<T> {
  const body: unknown = await response.json().catch((error: unknown) => {
    throw new A2AError(`${what} is not JSON: ${String(error)}`, { cause: error });
  });
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new A2AError(`${what} is not a JSON object`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new A2AError(`${what} has an unexpected shape: ${parsed.error.message}`);
  return parsed.data;
}

export interface A2AAgentOptions {
  /** URL of the Agent Card, usually `https://host/.well-known/agent-card.json`. */
  cardUrl: string;
  /** A bearer token, or headers sent on the card fetch and on every request to the card's origin. */
  auth?: string | Record<string, string>;
  /** The agent name for the run. Defaults to the card name, which is only known after the first turn. */
  name?: string;
  /** Timeout for each request and for a task to leave the submitted or working state, in ms. Defaults to 120000. */
  timeoutMs?: number;
  /** Also send `auth` to interfaces and redirects on other origins than the card's. */
  sendAuthToAnyHost?: boolean;
  /** Milliseconds between `GetTask` polls of an unfinished task. Defaults to 1000. */
  pollIntervalMs?: number;
}

const partsText = (message?: { parts?: { text?: unknown }[] | null } | null): string =>
  (message?.parts ?? []).flatMap((p) => (typeof p.text === "string" ? [p.text] : [])).join("\n");

const taskState = (task: A2ATask): string =>
  (task.status?.state ?? "").replace(/^TASK_STATE_/, "").toLowerCase().replace(/-/g, "_");

const taskText = (task: A2ATask): string =>
  [...(task.artifacts ?? []).map(partsText), partsText(task.status?.message)].filter(Boolean).join("\n");

const isV0 = (version?: string | null): boolean => (version ?? "").startsWith("0.");

/** The last user message among the new messages; old turns are never resent. */
function newUserText(input: AgentInput): string {
  for (const message of [...input.newMessages].reverse()) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content
      .map((p) => ("text" in p && typeof p.text === "string" ? p.text : ""))
      .join("\n");
  }
  throw new A2AError(
    "A2AAgent sends one user message per turn, and this turn has no new user message. " +
      "Put a user turn between two agent turns in the script.",
  );
}

/** Runs an A2A v1.0 agent as the agent under test, from its Agent Card URL. */
export class A2AAgent extends AgentAdapter {
  override name = "A2AAgent";
  override role = AgentRole.AGENT;
  readonly cardUrl: string;
  card?: AgentCard;
  private readonly authHeaders: Record<string, string>;
  private readonly contexts = new Map<string, string>();
  private readonly openTasks = new Map<string, string>();
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly sendAuthToAnyHost: boolean;
  private readonly fixedName?: string;

  constructor({
    cardUrl,
    auth,
    name,
    timeoutMs = 120_000,
    sendAuthToAnyHost = false,
    pollIntervalMs = 1000,
  }: A2AAgentOptions) {
    super();
    this.cardUrl = cardUrl;
    this.timeoutMs = timeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.sendAuthToAnyHost = sendAuthToAnyHost;
    this.fixedName = name;
    if (name) this.name = name;
    this.authHeaders = typeof auth === "string" ? { Authorization: `Bearer ${auth}` } : { ...auth };
  }

  /** Auth goes to the card's origin, or to its https upgrade, unless opted out. */
  private maySendAuth(url: string): boolean {
    if (this.sendAuthToAnyHost) return true;
    const card = new URL(this.cardUrl);
    const target = new URL(url);
    if (card.hostname !== target.hostname) return false;
    if (card.protocol === target.protocol) return card.port === target.port;
    return card.protocol === "http:" && target.protocol === "https:";
  }

  /** Follows up to five redirects, sending auth only where it may go. */
  private async request(
    url: string,
    init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: unknown },
  ): Promise<Response> {
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const headers: Record<string, string> = {
        ...(this.maySendAuth(target) ? this.authHeaders : {}),
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      };
      let response: Response;
      try {
        response = await fetch(target, {
          method: init.method,
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          redirect: "manual",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        throw new A2AError(`A2A request to ${target} failed: ${String(error)}`, { cause: error });
      }
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || !location) return response;
      target = new URL(location, target).toString();
    }
    throw new A2AError(`A2A request redirected more than ${MAX_REDIRECTS} times`);
  }

  private async loadCard(): Promise<AgentCard> {
    if (!this.card) {
      const response = await this.request(this.cardUrl, { method: "GET" });
      if (!response.ok) throw new A2AError(`Agent Card fetch failed with HTTP ${response.status}`);
      this.card = await parseBody(response, agentCardSchema, `The Agent Card at ${this.cardUrl}`);
      if (!this.fixedName) this.name = this.card.name ?? "A2AAgent";
    }
    return this.card;
  }

  private pickInterface(card: AgentCard): AgentInterface {
    const listed = card.supportedInterfaces ?? [];
    if (listed.length === 0) {
      if (isV0(card.protocolVersion) || card.preferredTransport) {
        throw new A2AError(
          `The Agent Card at ${this.cardUrl} is an A2A v${card.protocolVersion ?? "0.3"} card; ` +
            "A2AAgent speaks A2A v1.0 only.",
        );
      }
      throw new A2AError(`The Agent Card at ${this.cardUrl} lists no supportedInterfaces.`);
    }
    const interfaces = listed.flatMap((i) => {
      const parsed = interfaceSchema.safeParse(i);
      return parsed.success ? [parsed.data] : [];
    });
    const found = interfaces.find(
      (i) =>
        (SUPPORTED_BINDINGS as readonly string[]).includes(i.protocolBinding) && !isV0(i.protocolVersion),
    );
    if (found) return found;
    const seen = interfaces.map((i) => [i.protocolBinding, i.protocolVersion].filter(Boolean).join(" "));
    throw new A2AError(
      `The Agent Card at ${this.cardUrl} lists no supported interface (found ${JSON.stringify(
        seen,
      )}); A2AAgent supports ${JSON.stringify(SUPPORTED_BINDINGS)} on A2A v1.0.`,
    );
  }

  private async callMethod<T>(
    iface: AgentInterface,
    method: "SendMessage" | "GetTask",
    params: { message?: A2AMessage; id?: string },
    headers: Record<string, string>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const withTenant = iface.tenant ? { ...params, tenant: iface.tenant } : params;
    if (iface.protocolBinding === "HTTP+JSON") {
      const base = iface.url.replace(/\/$/, "") + (iface.tenant ? `/${encodeURIComponent(iface.tenant)}` : "");
      const response =
        method === "GetTask"
          ? await this.request(`${base}/tasks/${encodeURIComponent(params.id ?? "")}`, { method: "GET", headers })
          : await this.request(`${base}/message:send`, { method: "POST", headers, body: withTenant });
      const taskId = params.id ?? params.message?.taskId;
      if (response.status === 404 && taskId && (await isRestTaskNotFound(response))) {
        throw new A2AError(`A2A task ${taskId} was not found`, { taskNotFound: true });
      }
      if (!response.ok) throw new A2AError(`A2A agent answered HTTP ${response.status}`);
      return parseBody(response, schema, `The ${method} response`);
    }
    const response = await this.request(iface.url, {
      method: "POST",
      headers,
      body: { jsonrpc: "2.0", id: randomUUID(), method, params: withTenant },
    });
    if (!response.ok) throw new A2AError(`A2A agent answered HTTP ${response.status}`);
    const payload = await parseBody(response, jsonRpcResponseSchema, `The ${method} response`);
    if (payload.error) {
      throw new A2AError(
        `A2A agent returned JSON-RPC error ${String(payload.error.code)}: ${String(payload.error.message)}`,
        { taskNotFound: payload.error.code === TASK_NOT_FOUND_CODE },
      );
    }
    const parsed = schema.safeParse(payload.result);
    if (typeof payload.result !== "object" || payload.result === null || !parsed.success) {
      throw new A2AError(`The ${method} result is not a valid JSON object`);
    }
    return parsed.data;
  }

  /** Polls `GetTask` while the task is submitted or working. */
  private async waitForTask(iface: AgentInterface, task: A2ATask, headers: Record<string, string>): Promise<A2ATask> {
    const deadline = Date.now() + this.timeoutMs;
    let current = task;
    while (PENDING_STATES.includes(taskState(current))) {
      const state = taskState(current) || "unspecified";
      if (!current.id) throw new A2AError(`A2A task in state ${state} has no id to poll`);
      if (Date.now() >= deadline) {
        throw new A2AError(`A2A task ${current.id} is still ${state} after ${this.timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      current = await this.callMethod(iface, "GetTask", { id: current.id }, headers, taskSchema);
    }
    return current;
  }

  async call(input: AgentInput): Promise<AgentReturnTypes> {
    const text = newUserText(input);
    const card = await this.loadCard();
    const iface = this.pickInterface(card);
    const contextId = this.contexts.get(input.threadId) ?? randomUUID();
    this.contexts.set(input.threadId, contextId);
    const message: A2AMessage = {
      messageId: randomUUID(),
      contextId,
      role: "ROLE_USER",
      parts: [{ text }],
    };
    const openTask = this.openTasks.get(input.threadId);
    if (openTask) {
      message.taskId = openTask;
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
            [A2A_ATTRIBUTES.messageId]: message.messageId,
            "server.address": new URL(iface.url).hostname,
          });
          const headers: Record<string, string> = { "A2A-Version": A2A_PROTOCOL_VERSION };
          propagation.inject(context.active(), headers);
          const result = await this.callMethod(iface, "SendMessage", { message }, headers, sendMessageResultSchema);
          this.openTasks.delete(input.threadId);
          if (result.message) {
            if (result.message.contextId) this.contexts.set(input.threadId, result.message.contextId);
            return partsText(result.message);
          }
          if (!result.task) {
            const shape = "kind" in result ? " It looks like an A2A v0.3 result." : "";
            throw new A2AError(
              `The SendMessage result has neither a task nor a message (keys ${JSON.stringify(
                Object.keys(result).sort(),
              )}).${shape}`,
            );
          }
          const task = await this.waitForTask(iface, result.task, headers);
          const state = taskState(task);
          span.setAttributes({ [A2A_ATTRIBUTES.taskId]: task.id ?? "", [A2A_ATTRIBUTES.taskState]: state });
          if (task.contextId) this.contexts.set(input.threadId, task.contextId);
          if (!DONE_STATES.includes(state)) {
            throw new A2AError(`A2A task ${task.id} ended in state ${state}: ${partsText(task.status?.message)}`);
          }
          if (state === "input_required" && task.id) this.openTasks.set(input.threadId, task.id);
          return taskText(task);
        } catch (error) {
          if (error instanceof A2AError && error.taskNotFound) this.openTasks.delete(input.threadId);
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }
}
