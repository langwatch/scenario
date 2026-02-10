import { describe, it, expect } from "vitest";
import { convertModelMessagesToAguiMessages } from "./convert-core-messages-to-agui-messages";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeModelMessage(partial: any): any {
  return {
    id: "core-id",
    ...partial,
  };
}

describe("convertModelMessagesToAguiMessages", () => {
  it("converts a system message", () => {
    const input = [makeModelMessage({ role: "system", content: "sys" })];
    const result = convertModelMessagesToAguiMessages(input);
    expect(result).toEqual([{ id: "core-id", role: "system", content: "sys" }]);
  });

  it("converts a user message with string content", () => {
    const input = [makeModelMessage({ role: "user", content: "hello" })];
    const result = convertModelMessagesToAguiMessages(input);
    expect(result).toEqual([{ id: "core-id", role: "user", content: "hello" }]);
  });

  it("converts a user message with array content", () => {
    const arr = [{ type: "text", text: "hi" }];
    const input = [makeModelMessage({ role: "user", content: arr })];
    const result = convertModelMessagesToAguiMessages(input);
    expect(result).toEqual([
      { id: "core-id", role: "user", content: JSON.stringify(arr) },
    ]);
  });

  it("converts an assistant message with string content", () => {
    const input = [makeModelMessage({ role: "assistant", content: "response" })];
    const result = convertModelMessagesToAguiMessages(input);
    expect(result).toEqual([
      { id: "core-id", role: "assistant", content: "response" },
    ]);
  });

  it("converts an assistant message with array content", () => {
    const arr = [
      { type: "tool-call", toolCallId: "t1", toolName: "fn", input: { foo: 1 } },
      { type: "json", value: { bar: 2 } },
    ];
    const input = [makeModelMessage({ role: "assistant", content: arr })];
    const result = convertModelMessagesToAguiMessages(input);
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
      { type: "tool-result", toolName: "tool1", toolCallId: "t1", output: { type: "json", value: { foo: "bar" } } },
      { type: "tool-result", toolName: "tool2", toolCallId: "t2", output: { type: "json", value: { baz: 42 } } },
    ];
    const input = [makeModelMessage({ role: "tool", content: arr })];
    const result = convertModelMessagesToAguiMessages(input);
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
    const input = [makeModelMessage({ role: "banana", content: "nope" })];
    expect(() => convertModelMessagesToAguiMessages(input)).toThrow();
  });
});
