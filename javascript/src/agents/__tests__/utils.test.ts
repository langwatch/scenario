import { ModelMessage } from "ai";
import { describe, it, expect } from "vitest";
import { messageRoleReversal, criterionToParamName } from "../utils";

describe("messageRoleReversal", () => {
  it("should reverse user messages to assistant messages in simple segment", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Hello, how are you?" },
      { role: "user", content: "What's the weather like?" },
    ];

    const result = messageRoleReversal(messages);

    expect(result).toEqual([
      { role: "assistant", content: "Hello, how are you?" },
      { role: "assistant", content: "What's the weather like?" },
    ]);
  });

  it("should reverse assistant messages to user messages in simple segment", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: "I'm doing well, thank you!" },
      { role: "assistant", content: "It's sunny today." },
    ];

    const result = messageRoleReversal(messages);

    expect(result).toEqual([
      { role: "user", content: "I'm doing well, thank you!" },
      { role: "user", content: "It's sunny today." },
    ]);
  });

  it("should handle mixed user and assistant messages in simple segment", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "How are you?" },
    ];

    const result = messageRoleReversal(messages);

    expect(result).toEqual([
      { role: "assistant", content: "Hello" },
      { role: "user", content: "Hi there!" },
      { role: "assistant", content: "How are you?" },
    ]);
  });

  it("should reverse roles for messages regardless of content type", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Valid message" },
      { role: "user", content: null as unknown as string },
      { role: "user", content: undefined as unknown as string },
      { role: "assistant", content: "" },
      { role: "assistant", content: ["text part"] as unknown as string },
    ];

    const result = messageRoleReversal(messages);

    expect(result).toEqual([
      { role: "assistant", content: "Valid message" },
      { role: "assistant", content: null },
      { role: "assistant", content: undefined },
      { role: "user", content: "" },
      { role: "user", content: ["text part"] },
    ]);
  });

  it("should summarize tool messages and reverse non-tool messages", () => {
    const assistantWithToolCall = {
      role: "assistant" as const,
      content: [
        { type: "text", text: "I'll calculate that for you" },
        {
          type: "tool-call",
          toolCallId: "1",
          toolName: "calculator",
          input: { expression: "2+2" },
        },
      ],
    };

    const toolMessage = {
      role: "tool" as const,
      content: [
        {
          type: "tool-result",
          toolCallId: "1",
          toolName: "calculator",
          result: 4,
          output: { type: "json", value: 4 },
        },
      ],
    };

    const messages: ModelMessage[] = [
      { role: "user", content: "Calculate 2+2" },
      assistantWithToolCall as ModelMessage,
      toolMessage as ModelMessage,
      { role: "assistant", content: "The answer is 4" },
    ];

    const result = messageRoleReversal(messages);

    expect(result).toEqual([
      { role: "assistant", content: "Calculate 2+2" },
      { role: "user", content: '[Called tool calculator with: {"expression":"2+2"}]' },
      { role: "user", content: '[Tool result from calculator: {"type":"json","value":4}]' },
      { role: "user", content: "The answer is 4" },
    ]);
  });

  it("should handle conversation with multiple tool calls", () => {
    const assistantWithToolCall = {
      role: "assistant" as const,
      content: [
        {
          type: "tool-call",
          toolCallId: "2",
          toolName: "calc",
          input: { expr: "5*6" },
        },
      ],
    };

    const toolMessage = {
      role: "tool" as const,
      content: [
        {
          type: "tool-result",
          toolCallId: "2",
          toolName: "calc",
          output: { type: "json", value: 30 },
        },
      ],
    };

    const messages: ModelMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "What's 5*6?" },
      assistantWithToolCall as ModelMessage,
      toolMessage as ModelMessage,
      { role: "assistant", content: "The result is 30" },
      { role: "user", content: "Thanks!" },
    ];

    const result = messageRoleReversal(messages);

    expect(result).toEqual([
      { role: "assistant", content: "Hello" },
      { role: "user", content: "Hi there!" },
      { role: "assistant", content: "What's 5*6?" },
      { role: "user", content: '[Called tool calc with: {"expr":"5*6"}]' },
      { role: "user", content: '[Tool result from calc: {"type":"json","value":30}]' },
      { role: "user", content: "The result is 30" },
      { role: "assistant", content: "Thanks!" },
    ]);
  });

  it("should preserve system messages unchanged", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
    ];

    const result = messageRoleReversal(messages);

    expect(result).toEqual([
      { role: "system", content: "You are a helpful assistant" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "Hi!" },
    ]);
  });

  it("should handle empty array", () => {
    const messages: ModelMessage[] = [];
    const result = messageRoleReversal(messages);
    expect(result).toEqual([]);
  });

  it("should handle only tool messages", () => {
    const toolMessage = {
      role: "tool" as const,
      content: [
        {
          type: "tool-result",
          toolCallId: "1",
          toolName: "test",
          output: { type: "json", value: "test" },
        },
      ],
    };

    const messages: ModelMessage[] = [toolMessage as ModelMessage];

    const result = messageRoleReversal(messages);

    expect(result).toEqual([
      { role: "user", content: "[Tool result from test: test]" },
    ]);
  });

  it("should reverse assistant message with array content when no tool calls", () => {
    const assistantWithTextOnly = {
      role: "assistant" as const,
      content: [{ type: "text", text: "Just text content" }],
    };

    const messages: ModelMessage[] = [
      { role: "user", content: "Test" },
      assistantWithTextOnly as ModelMessage,
    ];

    const result = messageRoleReversal(messages);

    expect(result).toEqual([
      { role: "assistant", content: "Test" },
      { role: "user", content: [{ type: "text", text: "Just text content" }] },
    ]);
  });

  it("should handle tool-only agent response followed by user simulator call", () => {
    // Simulates the case where agent returns only tool-call + tool-result
    // with no final text response, and user simulator needs to respond
    const assistantWithToolCall = {
      role: "assistant" as const,
      content: [
        {
          type: "tool-call",
          toolCallId: "1",
          toolName: "lookup",
          input: { query: "headphones" },
        },
      ],
    };

    const toolMessage = {
      role: "tool" as const,
      content: [
        {
          type: "tool-result",
          toolCallId: "1",
          toolName: "lookup",
          output: { type: "text", value: "headphones: $29.99, in stock" },
        },
      ],
    };

    const messages: ModelMessage[] = [
      { role: "system", content: "You are pretending to be a user" },
      { role: "assistant", content: "Hello, how can I help you today" },
      { role: "user", content: "do you have headphones?" },
      assistantWithToolCall as ModelMessage,
      toolMessage as ModelMessage,
    ];

    const result = messageRoleReversal(messages);

    // After reversal, must end with user (not assistant) for Anthropic compatibility
    expect(result).toEqual([
      { role: "system", content: "You are pretending to be a user" },
      { role: "user", content: "Hello, how can I help you today" },
      { role: "assistant", content: "do you have headphones?" },
      { role: "user", content: '[Called tool lookup with: {"query":"headphones"}]' },
      { role: "user", content: "[Tool result from lookup: headphones: $29.99, in stock]" },
    ]);

    // Verify last message is "user" role (required by Anthropic)
    const lastMessage = result[result.length - 1];
    expect(lastMessage?.role).toBe("user");
  });
});

describe("criterionToParamName", () => {
  it("should convert basic string to lowercase parameter name", () => {
    const result = criterionToParamName("Response Quality");
    expect(result).toBe("response_quality");
  });

  it("should replace special characters with underscores", () => {
    const result = criterionToParamName("Cost-Effectiveness & Performance!");
    expect(result).toBe("cost_effectiveness___performance_");
  });

  it("should replace spaces with underscores", () => {
    const result = criterionToParamName("User Experience Score");
    expect(result).toBe("user_experience_score");
  });

  it("should remove quotes", () => {
    const result = criterionToParamName('User"s Satisfaction Level');
    expect(result).toBe("users_satisfaction_level");
  });

  it("should convert to lowercase", () => {
    const result = criterionToParamName("RESPONSE_QUALITY");
    expect(result).toBe("response_quality");
  });

  it("should truncate to 70 characters", () => {
    const longCriterion =
      "This is a very long criterion name that should be truncated because it exceeds the maximum length limit of seventy characters";
    const result = criterionToParamName(longCriterion);

    expect(result.length).toBe(70);
    expect(result).toBe(
      "this_is_a_very_long_criterion_name_that_should_be_truncated_because_it"
    );
  });

  it("should handle empty string", () => {
    const result = criterionToParamName("");
    expect(result).toBe("");
  });

  it("should handle string with only special characters", () => {
    const result = criterionToParamName("!@#$%^&*()");
    expect(result).toBe("__________");
  });

  it("should handle mixed alphanumeric and special characters", () => {
    const result = criterionToParamName("Metric-1: Quality & Speed (v2.0)");
    expect(result).toBe("metric_1__quality___speed__v2_0_");
  });

  it("should preserve numbers", () => {
    const result = criterionToParamName("Version 2.1 Performance");
    expect(result).toBe("version_2_1_performance");
  });

  it("should handle multiple consecutive spaces and special characters", () => {
    const result = criterionToParamName("Test   ---   Multiple    Spaces");
    expect(result).toBe("test_________multiple____spaces");
  });
});
