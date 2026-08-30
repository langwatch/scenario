/**
 * `scenario.run` accepts the function `connectAgent` returns.
 *
 * Binds `specs/connected-agent-adapter.feature`. The decorated function is
 * replaced by a fake with the same duck-typed shape: a function with a
 * `name` and an `environment`. No network and no LangWatch connection.
 */
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import type { ModelMessage } from "ai";
import { expect } from "vitest";

import { CONNECTED_AGENT_ADAPTER_FEATURE } from "../../__tests__/features";
import {
  AgentRole,
  isConnectedAgent,
  type AgentAdapter,
  type AgentInput,
  type AgentReturnTypes,
  type ConnectedAgentCall,
  type ConnectedAgentFunction,
} from "../../domain";
import { ConnectedAgentAdapter, readReply, resolveAgents } from "../connected-agent";

const feature = await loadFeature(CONNECTED_AGENT_ADAPTER_FEATURE);

/** A fake with the SDK's own call and reply types, so assignability is checked at compile time. */
interface SdkMessage {
  role: string;
  content?: unknown;
  [key: string]: unknown;
}
interface SdkDirectCall<P> {
  messages: SdkMessage[];
  newMessages?: SdkMessage[];
  threadId?: string;
  session?: unknown;
  params?: Partial<P>;
  traceId?: string;
}
interface SdkResult {
  output: string | SdkMessage | SdkMessage[];
  session?: unknown;
}
interface SdkConnectedAgent<P> {
  (call: SdkDirectCall<P>): Promise<SdkResult>;
  readonly name: string;
  readonly environment: string;
  readonly parameters: Record<string, unknown>;
  disconnect: () => Promise<void>;
}

interface Fake {
  agent: SdkConnectedAgent<{ model: string }>;
  calls: SdkDirectCall<{ model: string }>[];
  replies: unknown[];
}

function makeFake(name = "support-agent"): Fake {
  const calls: SdkDirectCall<{ model: string }>[] = [];
  const replies: unknown[] = [];
  const invoke = async (call: SdkDirectCall<{ model: string }>): Promise<SdkResult> => {
    calls.push(call);
    const reply = replies.length > 0 ? replies.shift() : `turn ${calls.length}`;
    return reply as SdkResult;
  };
  const agent = Object.assign(invoke, {
    environment: "development",
    parameters: {},
    disconnect: async () => undefined,
  });
  Object.defineProperty(agent, "name", { value: name, configurable: true });
  return { agent: agent as SdkConnectedAgent<{ model: string }>, calls, replies };
}

function makeInput(overrides: Partial<AgentInput> = {}): AgentInput {
  const messages: ModelMessage[] = [{ role: "user", content: "hello" }];
  return {
    threadId: "thread-1",
    messages,
    newMessages: messages,
    requestedRole: AgentRole.AGENT,
    propagationHeaders: {},
    scenarioState: {} as AgentInput["scenarioState"],
    scenarioConfig: {} as AgentInput["scenarioConfig"],
    ...overrides,
  };
}

const plainAdapter: AgentAdapter = {
  name: "plain",
  role: AgentRole.AGENT,
  async call(): Promise<AgentReturnTypes> {
    return "plain";
  },
};

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given, And }) => {
    Given("a function decorated with the LangWatch connect agent decorator", () => {
      expect(typeof makeFake().agent).toBe("function");
    });
    And("the decorated object is callable and exposes the connected agent shape", () => {
      expect(isConnectedAgent(makeFake().agent)).toBe(true);
    });
  });

  Scenario(
    "The decorated function is accepted as an agent without an adapter subclass",
    ({ Given, When, Then, And }) => {
      let fake: Fake;
      let resolved: AgentAdapter[];

      Given("a scenario with the decorated function in its agents list", () => {
        fake = makeFake();
      });
      When("the scenario resolves its agents", () => {
        // The SDK type is accepted where the duck-typed shape is declared.
        const accepted: ConnectedAgentFunction = fake.agent;
        resolved = resolveAgents([accepted, plainAdapter], { model: "gpt-5-mini" });
      });
      Then("the decorated function is wrapped into an agent adapter with the AGENT role", () => {
        expect(resolved[0]).toBeInstanceOf(ConnectedAgentAdapter);
        expect(resolved[0]?.role).toBe(AgentRole.AGENT);
        expect(resolved[0]?.name).toBe("support-agent");
        expect(isConnectedAgent(fake.agent)).toBe(true);
        expect(isConnectedAgent(plainAdapter)).toBe(false);
        expect(isConnectedAgent(() => "hi")).toBe(false);
      });
      And("an agent adapter in the same list is passed through unchanged", () => {
        expect(resolved[1]).toBe(plainAdapter);
      });
    },
  );

  Scenario("The wrapper builds the connected call from the scenario input", ({ Given, When, Then, And }) => {
    const fake = makeFake();
    const adapter = new ConnectedAgentAdapter(fake.agent);
    const messages: ModelMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ];
    const traceId = "0af7651916cd43dd8448eb211c80319c";
    let input: AgentInput;

    Given("the scenario calls the wrapped agent with messages, new messages and a thread id", () => {
      input = makeInput({
        threadId: "thread-7",
        messages,
        newMessages: messages.slice(2),
        propagationHeaders: { traceparent: `00-${traceId}-b7ad6b7169203331-01` },
      });
    });
    When("the wrapper invokes the decorated function", async () => {
      await adapter.call(input);
    });
    Then("the function receives the full messages and the new messages", () => {
      expect(fake.calls[0]?.messages).toEqual(messages);
      expect(fake.calls[0]?.newMessages).toEqual(messages.slice(2));
    });
    And("the function receives the scenario thread id", () => {
      expect(fake.calls[0]?.threadId).toBe("thread-7");
    });
    And("the function receives the trace id of the current turn", () => {
      expect(fake.calls[0]?.traceId).toBe(traceId);
    });
    And("the session is null on the first turn of a thread", () => {
      expect(fake.calls[0]?.session).toBeNull();
    });
  });

  Scenario("A string reply becomes the agent's message", ({ When, Then }) => {
    const fake = makeFake();
    let output: AgentReturnTypes;
    When("the decorated function returns a string", async () => {
      fake.replies.push("hello there");
      output = await new ConnectedAgentAdapter(fake.agent).call(makeInput());
    });
    Then("the scenario receives that string", () => {
      expect(output).toBe("hello there");
    });
  });

  Scenario("A single message reply is returned as is", ({ When, Then }) => {
    const fake = makeFake();
    const message: ModelMessage = { role: "assistant", content: "one message" };
    let output: AgentReturnTypes;
    When("the decorated function returns one message", async () => {
      fake.replies.push(message);
      output = await new ConnectedAgentAdapter(fake.agent).call(makeInput());
    });
    Then("the scenario receives that message", () => {
      expect(output).toEqual(message);
    });
  });

  Scenario("A list of messages reply is returned as is", ({ When, Then }) => {
    const fake = makeFake();
    const messages: ModelMessage[] = [
      { role: "assistant", content: "step one" },
      { role: "assistant", content: "step two" },
    ];
    let output: AgentReturnTypes;
    When("the decorated function returns a list of messages", async () => {
      fake.replies.push(messages);
      output = await new ConnectedAgentAdapter(fake.agent).call(makeInput());
    });
    Then("the scenario receives that list", () => {
      expect(output).toEqual(messages);
    });
  });

  Scenario("An output with session reply is unwrapped", ({ When, Then }) => {
    const fake = makeFake();
    const adapter = new ConnectedAgentAdapter(fake.agent);
    let output: AgentReturnTypes;
    When("the decorated function returns an output with a session", async () => {
      fake.replies.push({ output: "wrapped", session: { cursor: 1 } });
      output = await adapter.call(makeInput());
    });
    Then("the scenario receives the output alone", () => {
      expect(output).toBe("wrapped");
      expect(adapter.sessionFor("thread-1")).toEqual({ cursor: 1 });
      expect(readReply(null)).toEqual({ output: "", session: undefined });
      expect(readReply(42)).toEqual({ output: "42", session: undefined });
      expect(readReply({ output: undefined, session: "s" })).toEqual({ output: "", session: "s" });
    });
  });

  Scenario(
    "The session from one turn arrives on the next turn of the same thread",
    ({ Given, When, Then, And }) => {
      const fake = makeFake();
      const adapter = new ConnectedAgentAdapter(fake.agent);

      Given("the decorated function returned a session on the first turn of a thread", async () => {
        fake.replies.push({ output: "first", session: { conversation: "abc" } });
        await adapter.call(makeInput({ threadId: "thread-a" }));
      });
      When("the wrapper invokes the decorated function for the second turn of that thread", async () => {
        await adapter.call(makeInput({ threadId: "thread-a" }));
      });
      Then("the function receives that session", () => {
        expect(fake.calls[0]?.session).toBeNull();
        expect(fake.calls[1]?.session).toEqual({ conversation: "abc" });
      });
      And("a turn on another thread receives no session", async () => {
        await adapter.call(makeInput({ threadId: "thread-b" }));
        expect(fake.calls[2]?.session).toBeNull();
      });
    },
  );

  Scenario("A reply without a session keeps the session of the thread", ({ Given, And, When, Then }) => {
    const fake = makeFake();
    const adapter = new ConnectedAgentAdapter(fake.agent);

    Given("the decorated function returned a session on the first turn of a thread", async () => {
      fake.replies.push({ output: "first", session: "s-1" });
      await adapter.call(makeInput());
    });
    And("it returned a string on the second turn", async () => {
      fake.replies.push("plain second");
      await adapter.call(makeInput());
    });
    When("the wrapper invokes the decorated function for the third turn", async () => {
      await adapter.call(makeInput());
    });
    Then("the function still receives the session from the first turn", () => {
      expect(fake.calls[2]?.session).toBe("s-1");
    });
  });

  Scenario("Run parameters from the scenario reach the function", ({ Given, When, Then }) => {
    const fake = makeFake();
    let adapter: ConnectedAgentAdapter;
    Given("a scenario that sets a run parameter", () => {
      adapter = new ConnectedAgentAdapter(fake.agent, { model: "gpt-5-mini" });
    });
    When("the wrapper invokes the decorated function", async () => {
      await adapter.call(makeInput());
      // The function may change what it received; the next call gets a fresh copy.
      (fake.calls[0] as ConnectedAgentCall).params.model = "changed by the function";
      await adapter.call(makeInput());
    });
    Then("the function receives that parameter value", () => {
      expect(fake.calls[1]?.params).toEqual({ model: "gpt-5-mini" });
    });
  });

  Scenario("A run parameter the scenario does not set takes the function default", ({ Given, When, Then }) => {
    const fake = makeFake();
    let adapter: ConnectedAgentAdapter;
    Given("a scenario that sets no run parameter", () => {
      adapter = new ConnectedAgentAdapter(fake.agent);
    });
    When("the wrapper invokes the decorated function", async () => {
      await adapter.call(makeInput());
    });
    Then("the function receives no parameter and uses its own default", () => {
      expect(fake.calls[0]?.params).toEqual({});
    });
  });
});
