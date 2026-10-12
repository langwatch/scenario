// The deterministic fake model of the JS side. The script is duplicated,
// word for word, in ../../go/fake/script.go; change both together.
//
// Two ways to plug it in, both reported:
//
//   aisdk   A LanguageModelV3 object (specificationVersion "v3", doGenerate),
//           the shape of MockLanguageModelV3 from "ai/test" and of the stub
//           in javascript/src/voice/__tests__/factories.test.ts. Every call
//           goes through the AI SDK's generateText, with the telemetry the
//           SDK turns on (ai.generateText spans), as with a real provider.
//           MockLanguageModelV3 itself is not used: it keeps every call in
//           doGenerateCalls, which would grow over a benchmark, and "ai/test"
//           is not resolvable from the built package without an install.
//
//   direct  The way javascript/src agent tests fake the model (for example
//           judge-two-phase.unit.test.ts): the agent's invokeLLM property
//           is replaced by a function returning the canned result, so
//           generateText and the AI SDK are skipped. Closest to the Go side,
//           whose scenario.LLM interface has no SDK layer under it.

export const UserText =
  "Hi, I ordered a blue kettle last week and it has not arrived yet. Where is order 42?";
export const AgentText =
  "Your order 42 left our warehouse yesterday and should arrive within two days.";
export const OrderTool = "get_order_status";
export const OrderArgs = '{"order_id":"42"}';
export const OrderResult = '{"order_id":"42","status":"shipped","eta_days":2}';
export const Criterion = "Agent responds";
export const CriterionKey = "agent_responds";
export const FinishArgs =
  '{"criteria":{"agent_responds":{"requirement":"Agent responds","reasoning":"The agent answered with the order status.","status":"passed"}},"reasoning":"The agent answered the question."}';
export const ModelName = "fake-model";
export const Description = "A customer asks the support agent where their order is.";
export const MaxTurns = 10;

/** The whole script; see Decide in go/fake/script.go. */
export function decide(offered, lastIsToolResult) {
  if (offered("finish_test")) return { toolName: "finish_test", toolArgs: FinishArgs };
  if (offered("continue_test")) return { toolName: "continue_test", toolArgs: "{}" };
  if (offered(OrderTool)) {
    return lastIsToolResult ? { text: AgentText } : { toolName: OrderTool, toolArgs: OrderArgs };
  }
  return { text: UserText };
}

const v3Usage = () => ({
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
});

/**
 * One scripted model per run, shared by the user simulator, the judge and
 * the agent, so tool call ids run call_1, call_2, … as on the Go side.
 */
export class FakeBrain {
  calls = 0;

  answer(offered, lastIsToolResult) {
    this.calls++;
    const r = decide(offered, lastIsToolResult);
    return { ...r, toolCallId: `call_${this.calls}` };
  }

  /** A LanguageModelV3 answering from the script. */
  languageModel() {
    const brain = this;
    return {
      specificationVersion: "v3",
      provider: "fake",
      modelId: ModelName,
      supportedUrls: {},
      async doGenerate(options) {
        const names = new Set((options.tools ?? []).map((t) => t.name));
        const prompt = options.prompt ?? [];
        const last = prompt[prompt.length - 1];
        const r = brain.answer((n) => names.has(n), last?.role === "tool");
        if (r.toolName) {
          return {
            content: [
              { type: "tool-call", toolCallId: r.toolCallId, toolName: r.toolName, input: r.toolArgs },
            ],
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage: v3Usage(),
            warnings: [],
          };
        }
        return {
          content: [{ type: "text", text: r.text }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: v3Usage(),
          warnings: [],
        };
      },
      async doStream() {
        throw new Error("doStream is not used by the benchmark");
      },
    };
  }

  /** An invokeLLM replacement answering from the script (direct mode). */
  invokeLLM() {
    return async (params) => {
      const names = new Set(Object.keys(params.tools ?? {}));
      const msgs = params.messages ?? [];
      const last = msgs[msgs.length - 1];
      const r = this.answer((n) => names.has(n), last?.role === "tool");
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
      if (r.toolName) {
        return {
          text: "",
          content: [],
          toolCalls: [
            { type: "tool-call", toolCallId: r.toolCallId, toolName: r.toolName, input: JSON.parse(r.toolArgs) },
          ],
          toolResults: [],
          finishReason: "tool-calls",
          usage,
        };
      }
      return {
        text: r.text,
        content: [{ type: "text", text: r.text }],
        toolCalls: [],
        toolResults: [],
        finishReason: "stop",
        usage,
      };
    };
  }
}

/**
 * The agent under test, the twin of go/fake/agent.go: per turn it asks its
 * model, runs get_order_status and asks again, returning the tool call, the
 * tool result and the answer.
 *
 * aisdk:  generateText with one tool (with execute) and stopWhen
 *         stepCountIs(2), returning response.messages. Telemetry stays off,
 *         as in a typical agent and as on the Go side, which starts no span
 *         for model calls.
 * direct: the same three messages, built from two scripted answers.
 */
export function makeOrderAgent(sdk, ai, brain, mode) {
  const orderResult = JSON.parse(OrderResult);
  const model = mode === "aisdk" ? brain.languageModel() : undefined;
  class OrderAgent extends sdk.AgentAdapter {
    role = sdk.AgentRole.AGENT;
    name = "OrderAgent";

    async call(input) {
      if (mode === "aisdk") {
        const result = await ai.generateText({
          model,
          messages: input.messages,
          tools: {
            [OrderTool]: ai.tool({
              description: "Look up the shipping status of an order.",
              inputSchema: ai.jsonSchema({
                type: "object",
                properties: { order_id: { type: "string" } },
                required: ["order_id"],
                additionalProperties: false,
              }),
              execute: async () => orderResult,
            }),
          },
          stopWhen: ai.stepCountIs(2),
        });
        return result.response.messages;
      }
      const offered = (n) => n === OrderTool;
      const call = brain.answer(offered, false);
      const answer = brain.answer(offered, true);
      return [
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: call.toolCallId, toolName: OrderTool, input: JSON.parse(call.toolArgs) },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: OrderTool,
              output: { type: "json", value: orderResult },
            },
          ],
        },
        { role: "assistant", content: answer.text },
      ];
    }
  }
  return new OrderAgent();
}

/** The cold start agent: fixed text, no model (go/fake EchoAgent). */
export function makeEchoAgent(sdk) {
  class EchoAgent extends sdk.AgentAdapter {
    role = sdk.AgentRole.AGENT;
    async call() {
      return AgentText;
    }
  }
  return new EchoAgent();
}
