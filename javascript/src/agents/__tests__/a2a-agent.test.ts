import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { ModelMessage } from "ai";
import { expect } from "vitest";
import { A2A_AGENT_ADAPTER_FEATURE } from "../../__tests__/features";
import type { AgentInput } from "../../domain";
import { A2AAgent, A2AError } from "../a2a-agent";
import { FakeA2AServer, textMessage, type Reply } from "./fixtures/fake-a2a-server";

const feature = await loadFeature(A2A_AGENT_ADAPTER_FEATURE);

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
trace.setGlobalTracerProvider(provider);

const input = (text: string, threadId = "thread-1"): AgentInput => {
  const messages: ModelMessage[] = [{ role: "user", content: text }];
  return { threadId, messages, newMessages: messages } as unknown as AgentInput;
};

const task = (state: string, text: string) => (params: { message: { contextId: string } }) => ({
  task: {
    id: "task-1",
    contextId: params.message.contextId,
    status: { state, message: { role: "ROLE_AGENT", parts: [{ text }] } },
  },
});

let server: FakeA2AServer;
const start = async (options: ConstructorParameters<typeof FakeA2AServer>[0] = {}) =>
  (server = await new FakeA2AServer(options).start());

describeFeature(feature, ({ Background, Scenario, AfterEachScenario }) => {
  AfterEachScenario(async () => {
    await server?.stop();
  });

  Background(({ Given, And }) => {
    Given('an A2A agent that serves an Agent Card at "/.well-known/agent-card.json"', () => {});
    And('the card lists a JSONRPC or HTTP+JSON interface in "supportedInterfaces"', () => {});
  });

  Scenario("The adapter reads the card on the first turn", ({ When, Then, And }) => {
    let agent: A2AAgent;
    When("the scenario calls the A2A agent for the first time", async () => {
      await start();
      agent = new A2AAgent({ cardUrl: server.cardUrl });
      expect(await agent.call(input("hi"))).toBe("echo: hi");
      await agent.call(input("again"));
    });
    Then("the adapter fetches the Agent Card once", () => {
      expect(server.cardHeaders).toHaveLength(1);
    });
    And("the adapter takes its name from the card name", () => {
      expect(agent.name).toBe("Fake A2A Agent");
    });
    And("the adapter sends the turn to the first supported interface of the card", () => {
      expect(server.requests[0]?.path).toBe("/a2a");
    });
  });

  Scenario("A card without a supported interface is refused", ({ Given, When, Then }) => {
    let error: unknown;
    Given("the card lists only a GRPC interface", async () => {
      await start({ binding: "GRPC" });
    });
    When("the scenario calls the A2A agent", async () => {
      error = await new A2AAgent({ cardUrl: server.cardUrl }).call(input("hi")).catch((e) => e);
    });
    Then("the call fails with an error that names the transports the adapter supports", () => {
      expect(error).toBeInstanceOf(A2AError);
      expect(String(error)).toContain("JSONRPC");
    });
  });

  Scenario("Every turn of one scenario run shares one contextId", ({ When, Then, And }) => {
    When("the scenario runs two turns against the A2A agent", async () => {
      await start();
      const agent = new A2AAgent({ cardUrl: server.cardUrl });
      await agent.call(input("one"));
      await agent.call(input("two"));
      await agent.call(input("other", "thread-2"));
    });
    Then('each turn is a "SendMessage" request with the last user message as a text part', () => {
      expect(server.requests[0]?.body.method).toBe("SendMessage");
      expect(server.requests[0]?.body.params.message.parts).toEqual([{ text: "one" }]);
      expect(server.requests[0]?.body.params.message.role).toBe("ROLE_USER");
    });
    And("both requests carry the same contextId", () => {
      const [a, b] = server.requests.map((r) => r.body.params.message.contextId);
      expect(a).toBe(b);
    });
    And("a second scenario thread gets a different contextId", () => {
      const ids = server.requests.map((r) => r.body.params.message.contextId);
      expect(ids[2]).not.toBe(ids[0]);
    });
  });

  Scenario("The agent reply becomes the agent message", ({ When, Then }) => {
    const replies: string[] = [];
    When("the agent answers with a message, a completed task or an input-required task", async () => {
      const kinds: Reply[] = [
        (p) => textMessage("from message", p.message.contextId),
        task("TASK_STATE_COMPLETED", "from completed task"),
        task("TASK_STATE_INPUT_REQUIRED", "from input-required task"),
      ];
      for (const reply of kinds) {
        await start({ reply });
        replies.push(String(await new A2AAgent({ cardUrl: server.cardUrl }).call(input("hi"))));
        await server.stop();
      }
      await start({ reply: task("TASK_STATE_INPUT_REQUIRED", "more?") });
      const agent = new A2AAgent({ cardUrl: server.cardUrl });
      await agent.call(input("first"));
      await agent.call(input("second"));
    });
    Then("the scenario receives the text parts of the reply as the agent message", () => {
      expect(replies).toEqual(["from message", "from completed task", "from input-required task"]);
      expect(server.requests[1]?.body.params.message.taskId).toBe("task-1");
    });
  });

  Scenario("An expired task is dropped so the next turn starts fresh", ({ Given, When, Then, And }) => {
    const errors: unknown[] = [];
    const expiring: Reply = (p) =>
      p.message.taskId
        ? {
            error: {
              code: -32001,
              message: "Task not found",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                  reason: "TASK_NOT_FOUND",
                  domain: "a2a-protocol.org",
                },
              ],
            },
          }
        : task("TASK_STATE_INPUT_REQUIRED", "need more")(p);
    const agents: A2AAgent[] = [];
    const servers: FakeA2AServer[] = [];
    Given("the agent answered the last turn with an input-required task", async () => {
      for (const binding of ["JSONRPC", "HTTP+JSON"]) {
        const s = await new FakeA2AServer({ reply: expiring, binding }).start();
        const agent = new A2AAgent({ cardUrl: s.cardUrl });
        await agent.call(input("hi"));
        servers.push(s);
        agents.push(agent);
      }
    });
    When("the agent answers the continuation with a task-not-found error", async () => {
      for (const agent of agents) errors.push(await agent.call(input("more")).catch((e) => e));
    });
    Then("the call raises an error marked as task not found", () => {
      for (const error of errors) {
        expect(error).toBeInstanceOf(A2AError);
        expect((error as A2AError).taskNotFound).toBe(true);
      }
    });
    And("the next turn is sent without a taskId", async () => {
      for (const [i, agent] of agents.entries()) {
        await agent.call(input("again"));
        const body = servers[i]!.requests[2]!.body;
        expect((body.params ?? body).message.taskId).toBeUndefined();
        await servers[i]!.stop();
      }
    });
  });

  Scenario("Other errors keep the open task for a retry", ({ Given, When, Then }) => {
    let calls = 0;
    let agent: A2AAgent;
    Given("the agent answered the last turn with an input-required task", async () => {
      await start({
        reply: (p) =>
          ++calls === 2
            ? { error: { code: -32603, message: "Internal error" } }
            : task("TASK_STATE_INPUT_REQUIRED", "need more")(p),
      });
      agent = new A2AAgent({ cardUrl: server.cardUrl });
      await agent.call(input("hi"));
    });
    When("the agent answers the continuation with a JSON-RPC internal error", async () => {
      const error = await agent.call(input("more")).catch((e) => e);
      expect((error as A2AError).taskNotFound).toBe(false);
    });
    Then("the next turn still continues the open task", async () => {
      await agent.call(input("retry"));
      expect(server.requests[2]?.body.params.message.taskId).toBe("task-1");
    });
  });

  Scenario("A plain HTTP 404 keeps the open task for a retry", ({ Given, When, Then }) => {
    let calls = 0;
    let agent: A2AAgent;
    Given("the agent answered the last turn with an input-required task", async () => {
      await start({
        binding: "HTTP+JSON",
        reply: (p) =>
          ++calls === 2
            ? { error: { code: 404, message: "Not Found" } }
            : task("TASK_STATE_INPUT_REQUIRED", "need more")(p),
      });
      agent = new A2AAgent({ cardUrl: server.cardUrl });
      await agent.call(input("hi"));
    });
    When("the HTTP+JSON agent answers the continuation with a 404 that has no TASK_NOT_FOUND detail", async () => {
      const error = await agent.call(input("more")).catch((e) => e);
      expect((error as A2AError).taskNotFound).toBe(false);
    });
    Then("the next turn still continues the open task", async () => {
      await agent.call(input("retry"));
      const body = server.requests[2]!.body;
      expect((body.params ?? body).message.taskId).toBe("task-1");
    });
  });

  Scenario("A 404 body of an unexpected shape fails with the HTTP status", ({ Given, When, Then }) => {
    let calls = 0;
    let agent: A2AAgent;
    let error: unknown;
    Given("the agent answered the last turn with an input-required task", async () => {
      await start({
        binding: "HTTP+JSON",
        reply: (p) =>
          ++calls === 2 ? { error: "Not Found" } : task("TASK_STATE_INPUT_REQUIRED", "need more")(p),
      });
      agent = new A2AAgent({ cardUrl: server.cardUrl });
      await agent.call(input("hi"));
    });
    When("the HTTP+JSON agent answers the continuation with a 404 whose error is a plain string", async () => {
      error = await agent.call(input("more")).catch((e) => e);
    });
    Then("the call fails with the HTTP 404 status and is not marked task-not-found", () => {
      expect(String(error)).toMatch(/HTTP 404/);
      expect((error as A2AError).taskNotFound).toBe(false);
    });
  });

  Scenario("A failed or rejected task fails the turn", ({ When, Then }) => {
    const errors: unknown[] = [];
    When(
      'the agent answers with a task in state "TASK_STATE_FAILED" or "TASK_STATE_REJECTED"',
      async () => {
        for (const state of ["TASK_STATE_FAILED", "TASK_STATE_REJECTED"]) {
          await start({ reply: task(state, "no can do") });
          errors.push(await new A2AAgent({ cardUrl: server.cardUrl }).call(input("hi")).catch((e) => e));
          await server.stop();
        }
      },
    );
    Then("the call raises an error that carries the task state and the status message text", () => {
      expect(String(errors[0])).toMatch(/failed: no can do/);
      expect(String(errors[1])).toMatch(/rejected: no can do/);
    });
  });

  Scenario("A JSON-RPC error fails the turn", ({ When, Then }) => {
    let error: unknown;
    When("the agent answers with a JSON-RPC error object", async () => {
      await start({ jsonrpcError: { code: -32602, message: "Invalid parameters" } });
      error = await new A2AAgent({ cardUrl: server.cardUrl }).call(input("hi")).catch((e) => e);
    });
    Then("the call raises an error that carries the error code and message", () => {
      expect(String(error)).toContain("-32602: Invalid parameters");
    });
  });

  Scenario("The request carries the scenario trace context", ({ Given, When, Then, And }) => {
    let traceId = "";
    Given("the scenario turn runs inside a span", async () => {
      await start();
    });
    When("the adapter sends the turn", async () => {
      const tracer = trace.getTracer("test");
      await tracer.startActiveSpan("scenario turn", async (span) => {
        traceId = span.spanContext().traceId;
        await new A2AAgent({ cardUrl: server.cardUrl }).call(input("hi"));
        span.end();
      });
    });
    Then('the request carries a W3C "traceparent" header with the scenario trace id', () => {
      expect(String(server.requests[0]?.headers.traceparent).split("-")[1]).toBe(traceId);
    });
    And('the request carries the "A2A-Version" header with value "1.0"', () => {
      expect(server.requests[0]?.headers["a2a-version"]).toBe("1.0");
    });
    And('the client span carries "gen_ai.agent.name" from the card and the "a2a.*" attributes', () => {
      const span = exporter
        .getFinishedSpans()
        .find((s) => s.name.startsWith("invoke_agent") && s.spanContext().traceId === traceId);
      expect(span?.attributes["gen_ai.agent.name"]).toBe("Fake A2A Agent");
      expect(span?.attributes["a2a.method"]).toBe("SendMessage");
      expect(span?.attributes["a2a.protocol.binding"]).toBe("JSONRPC");
    });
  });

  Scenario("Auth reaches the card fetch and every request", ({ Given, When, Then }) => {
    let agents: A2AAgent[] = [];
    Given("the adapter is built with a bearer token or a header mapping", async () => {
      await start();
      agents = [
        new A2AAgent({ cardUrl: server.cardUrl, auth: "tok" }),
        new A2AAgent({ cardUrl: server.cardUrl, auth: { "X-Api-Key": "k" } }),
      ];
    });
    When("the adapter fetches the card and sends a turn", async () => {
      for (const agent of agents) await agent.call(input("hi"));
    });
    Then("both requests carry the auth headers", () => {
      expect(server.cardHeaders[0]?.authorization).toBe("Bearer tok");
      expect(server.requests[0]?.headers.authorization).toBe("Bearer tok");
      expect(server.cardHeaders[1]?.["x-api-key"]).toBe("k");
      expect(server.requests[1]?.headers["x-api-key"]).toBe("k");
    });
  });

  Scenario("An A2A v0.3 Agent Card is refused with an error that names the version", ({ Given, When, Then, And }) => {
    const servers: FakeA2AServer[] = [];
    const errors: unknown[] = [];
    Given('the card has no "supportedInterfaces" and reports protocol version 0.3 or a preferred transport', async () => {
      for (const card of [
        { name: "old", protocolVersion: "0.3.0", url: "http://x/", preferredTransport: "JSONRPC" },
        { name: "old", url: "http://x/", preferredTransport: "HTTP+JSON" },
      ]) {
        servers.push(await new FakeA2AServer({ card }).start());
      }
    });
    When("the scenario calls the A2A agent", async () => {
      for (const s of servers) errors.push(await new A2AAgent({ cardUrl: s.cardUrl }).call(input("hi")).catch((e) => e));
    });
    Then("the call fails with an error that says the adapter speaks A2A v1.0 only", () => {
      for (const error of errors) {
        expect(error).toBeInstanceOf(A2AError);
        expect(String(error)).toContain("v1.0 only");
      }
    });
    And("no message is sent", async () => {
      for (const s of servers) {
        expect(s.requests).toHaveLength(0);
        await s.stop();
      }
    });
  });

  Scenario("The adapter skips v0.x interfaces and sends the interface tenant", ({ Given, When, Then }) => {
    Given("the card lists a v0.3 interface before a v1.0 HTTP+JSON interface with a tenant", async () => {
      await start({ binding: "HTTP+JSON", tenant: "acme" });
      const card = server.card() as { supportedInterfaces: unknown[] };
      card.supportedInterfaces.unshift({ url: `${server.baseUrl}/old`, protocolBinding: "JSONRPC", protocolVersion: "0.3" });
      server.options.card = card;
    });
    When("the scenario calls the A2A agent", async () => {
      await new A2AAgent({ cardUrl: server.cardUrl }).call(input("hi"));
    });
    Then("the turn goes to the v1.0 interface under the tenant path and carries the tenant", () => {
      expect(server.requests[0]?.path).toBe("/a2a/acme/message:send");
      expect((server.requests[0]?.body as unknown as { tenant: string }).tenant).toBe("acme");
    });
  });

  Scenario("A result with neither a task nor a message fails the turn", ({ When, Then }) => {
    const errors: unknown[] = [];
    When("the agent answers with a v0.3 shaped message or an empty result", async () => {
      for (const result of [{ kind: "message", parts: [{ kind: "text", text: "REAL ANSWER" }] }, {}]) {
        await start({ reply: () => result });
        errors.push(await new A2AAgent({ cardUrl: server.cardUrl }).call(input("hi")).catch((e) => e));
        await server.stop();
      }
    });
    Then("the call fails instead of returning an empty agent message", () => {
      for (const error of errors) {
        expect(error).toBeInstanceOf(A2AError);
        expect(String(error)).toContain("neither a task nor a message");
      }
      expect(String(errors[0])).toContain("v0.3");
    });
  });

  Scenario("A submitted or working task is polled until it finishes", ({ When, Then, And }) => {
    const replies: string[] = [];
    const polls: string[] = [];
    When('the agent answers with a working task that completes on the second "GetTask"', async () => {
      for (const binding of ["JSONRPC", "HTTP+JSON"]) {
        let n = 0;
        await start({
          binding,
          reply: task("TASK_STATE_WORKING", ""),
          getTask: ({ id }) => {
            polls.push(id);
            return task(++n < 2 ? "TASK_STATE_WORKING" : "TASK_STATE_COMPLETED", "done")({ message: { contextId: "ctx" } }).task;
          },
        });
        replies.push(String(await new A2AAgent({ cardUrl: server.cardUrl, pollIntervalMs: 10 }).call(input("hi"))));
        await server.stop();
      }
    });
    Then("the scenario receives the text of the completed task", () => {
      expect(replies).toEqual(["done", "done"]);
      expect(polls).toEqual(["task-1", "task-1", "task-1", "task-1"]);
    });
    And("a task that stays working fails the turn after the timeout", async () => {
      const working = task("TASK_STATE_WORKING", "");
      await start({ reply: working, getTask: () => working({ message: { contextId: "ctx" } }).task });
      const agent = new A2AAgent({ cardUrl: server.cardUrl, pollIntervalMs: 10, timeoutMs: 100 });
      const error = await agent.call(input("hi")).catch((e) => e);
      expect(error).toBeInstanceOf(A2AError);
      expect(String(error)).toContain("still working");
    });
  });

  Scenario("Auth stays on the card origin", ({ Given, When, Then, And }) => {
    let other: FakeA2AServer;
    Given("the card names an interface on another origin", async () => {
      other = await new FakeA2AServer().start();
      await start({
        card: { name: "home", supportedInterfaces: [{ url: `${other.baseUrl}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }] },
      });
    });
    When("the adapter sends a turn", async () => {
      await new A2AAgent({ cardUrl: server.cardUrl, auth: "SECRET" }).call(input("hi"));
      await new A2AAgent({ cardUrl: server.cardUrl, auth: "SECRET", sendAuthToAnyHost: true }).call(input("hi"));
    });
    Then("the other origin receives no auth headers unless the caller opts in", () => {
      expect(server.cardHeaders[0]?.authorization).toBe("Bearer SECRET");
      expect(other.requests[0]?.headers.authorization).toBeUndefined();
      expect(other.requests[1]?.headers.authorization).toBe("Bearer SECRET");
    });
    And("a card redirect to another origin is followed without the auth headers", async () => {
      await server.stop();
      await start({ cardRedirect: other.cardUrl });
      const agent = new A2AAgent({ cardUrl: server.cardUrl, auth: { "X-Api-Key": "SECRET" } });
      expect(await agent.call(input("hi"))).toBe("echo: hi");
      expect(server.cardHeaders[0]?.["x-api-key"]).toBe("SECRET");
      expect(other.cardHeaders[0]?.["x-api-key"]).toBeUndefined();
      await other.stop();
    });
  });

  Scenario("HTTP, network and body failures raise the adapter error", ({ When, Then }) => {
    const errors: unknown[] = [];
    When("the card fetch fails with HTTP 500, the reply is a JSON array, or the host is unreachable", async () => {
      for (const options of [{ cardStatus: 500 }, { rawReply: "[]" }]) {
        await start(options);
        errors.push(await new A2AAgent({ cardUrl: server.cardUrl }).call(input("hi")).catch((e) => e));
        await server.stop();
      }
      errors.push(
        await new A2AAgent({ cardUrl: "http://127.0.0.1:1/.well-known/agent-card.json" }).call(input("hi")).catch((e) => e),
      );
    });
    Then("each call raises the adapter error", () => {
      for (const error of errors) expect(error).toBeInstanceOf(A2AError);
      expect(String(errors[0])).toContain("HTTP 500");
      expect(String(errors[1])).toContain("not a JSON object");
    });
  });

  Scenario("A name given to the adapter is the agent name from the start", ({ Given, When, Then }) => {
    let agent: A2AAgent;
    Given("the adapter is built with a name", async () => {
      await start();
      agent = new A2AAgent({ cardUrl: server.cardUrl, name: "Refund agent" });
      expect(agent.name).toBe("Refund agent");
    });
    When("the scenario calls the A2A agent", async () => {
      await agent.call(input("hi"));
    });
    Then("the adapter keeps that name before and after the card is read", () => {
      expect(agent.name).toBe("Refund agent");
    });
  });

  Scenario("A turn without a new user message fails instead of resending old text", ({ Given, When, Then, And }) => {
    let turn: AgentInput;
    let error: unknown;
    Given("the new messages of the turn hold no user message", async () => {
      await start();
      const reply: ModelMessage = { role: "assistant", content: "reply" };
      turn = { threadId: "t", messages: [{ role: "user", content: "old" }, reply], newMessages: [reply] } as unknown as AgentInput;
    });
    When("the scenario calls the A2A agent", async () => {
      error = await new A2AAgent({ cardUrl: server.cardUrl }).call(turn).catch((e) => e);
    });
    Then("the call fails with an error that asks for a user turn", () => {
      expect(error).toBeInstanceOf(A2AError);
      expect(String(error)).toContain("no new user message");
    });
    And("no message is sent", () => {
      expect(server.requests).toHaveLength(0);
    });
  });
});
