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
});
