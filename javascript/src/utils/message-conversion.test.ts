import { describe, it, expect } from "vitest";
import { convertCoreMessagesToAguiMessages } from "./convert-core-messages-to-agui-messages";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeCoreMessage(partial: any): any {
  return {
    id: "core-id",
    ...partial,
  };
}

describe("convertCoreMessagesToAguiMessages", () => {
  it("converts a system message", () => {
    const input = [makeCoreMessage({ role: "system", content: "sys" })];
    const result = convertCoreMessagesToAguiMessages(input);
    expect(result).toEqual([{ id: "core-id", role: "system", content: "sys" }]);
  });

  it("converts a user message with string content", () => {
    const input = [makeCoreMessage({ role: "user", content: "hello" })];
    const result = convertCoreMessagesToAguiMessages(input);
    expect(result).toEqual([{ id: "core-id", role: "user", content: "hello" }]);
  });

  it("converts a user message with array content", () => {
    const arr = [{ type: "text", text: "hi" }];
    const input = [makeCoreMessage({ role: "user", content: arr })];
    const result = convertCoreMessagesToAguiMessages(input);
    expect(result).toEqual([
      { id: "core-id", role: "user", content: JSON.stringify(arr) },
    ]);
  });

  it("converts an assistant message with string content", () => {
    const input = [makeCoreMessage({ role: "assistant", content: "response" })];
    const result = convertCoreMessagesToAguiMessages(input);
    expect(result).toEqual([
      { id: "core-id", role: "assistant", content: "response" },
    ]);
  });

  it("converts an assistant message with array content", () => {
    const arr = [
      { type: "tool-call", toolCallId: "t1", toolName: "fn", args: { foo: 1 } },
      { type: "json", value: { bar: 2 } },
    ];
    const input = [makeCoreMessage({ role: "assistant", content: arr })];
    const result = convertCoreMessagesToAguiMessages(input);
    expect(result[0].content).toBe(
      JSON.stringify([{ type: "json", value: { bar: 2 } }])
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result[0] as any).toolCalls).toEqual([
      {
        id: "t1",
        type: "function",
        function: {
          name: "fn",
          arguments: JSON.stringify({ foo: 1 }),
        },
      },
    ]);
  });

  it("converts a tool message with multiple parts", () => {
    const arr = [
      { toolCallId: "t1", result: { foo: "bar" } },
      { toolCallId: "t2", result: { baz: 42 } },
    ];
    const input = [makeCoreMessage({ role: "tool", content: arr })];
    const result = convertCoreMessagesToAguiMessages(input);
    expect(result).toEqual([
      {
        id: "core-id-0",
        role: "tool",
        toolCallId: "t1",
        content: JSON.stringify({ foo: "bar" }),
      },
      {
        id: "core-id-1",
        role: "tool",
        toolCallId: "t2",
        content: JSON.stringify({ baz: 42 }),
      },
    ]);
  });

  it("throws on unsupported message role", () => {
    const input = [makeCoreMessage({ role: "banana", content: "nope" })];
    expect(() => convertCoreMessagesToAguiMessages(input)).toThrow();
  });
});
