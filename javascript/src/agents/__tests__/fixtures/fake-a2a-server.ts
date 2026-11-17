import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Shape of a SendMessage params object as the fake server receives it. */
export type SendMessageParams = {
  message: { messageId: string; contextId: string; taskId?: string; role: string; parts: { text: string }[] };
};
export type Reply = (params: SendMessageParams) => unknown;
export type RecordedBody = { id?: string; method?: string; params: SendMessageParams };
export type RecordedRequest = { path: string; headers: IncomingHttpHeaders; body: RecordedBody };

export const textMessage = (text: string, contextId: string) => ({
  message: { messageId: "reply", contextId, role: "ROLE_AGENT", parts: [{ text }] },
});

export const echoReply: Reply = (params) =>
  textMessage(`echo: ${params.message.parts[0]?.text}`, params.message.contextId);

/** A local A2A agent: an Agent Card plus JSON-RPC and HTTP+JSON SendMessage. */
export class FakeA2AServer {
  requests: RecordedRequest[] = [];
  cardHeaders: IncomingHttpHeaders[] = [];
  baseUrl = "";
  private server?: Server;

  constructor(
    public options: {
      reply?: Reply;
      binding?: string;
      name?: string;
      jsonrpcError?: { code: number; message: string };
    } = {},
  ) {}

  get cardUrl(): string {
    return `${this.baseUrl}/.well-known/agent-card.json`;
  }

  card() {
    return {
      name: this.options.name ?? "Fake A2A Agent",
      description: "A fake agent for tests",
      version: "1.0.0",
      supportedInterfaces: [
        { url: `${this.baseUrl}/a2a`, protocolBinding: this.options.binding ?? "JSONRPC", protocolVersion: "1.0" },
      ],
      capabilities: { streaming: false },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [{ id: "echo", name: "Echo", description: "Echoes", tags: [] }],
    };
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const send = (payload: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "GET") {
        this.cardHeaders.push(req.headers);
        send(this.card());
        return;
      }
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw) as RecordedBody;
        this.requests.push({ path: req.url ?? "", headers: req.headers, body });
        const reply = this.options.reply ?? echoReply;
        if (this.options.binding === "HTTP+JSON") return send(reply(body as unknown as SendMessageParams));
        if (this.options.jsonrpcError) {
          return send({ jsonrpc: "2.0", id: body.id, error: this.options.jsonrpcError });
        }
        send({ jsonrpc: "2.0", id: body.id, result: reply(body.params) });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
