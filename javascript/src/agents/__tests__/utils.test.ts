import { CoreMessage } from "ai";
import { describe, it, expect } from "vitest";
import { messageRoleReversal, criterionToParamName } from "../utils";

describe("messageRoleReversal", () => {
  it("should reverse user messages to assistant messages in simple segment", () => {
    const messages: CoreMessage[] = [
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
    const messages: CoreMessage[] = [
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
    const messages: CoreMessage[] = [
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

  it("should preserve messages without string content unchanged", () => {
    const messages: CoreMessage[] = [
      { role: "user", content: "Valid message" },
      { role: "user", content: null as unknown as string },
      { role: "user", content: undefined as unknown as string },
      { role: "assistant", content: "" },
      { role: "assistant", content: ["text part"] as unknown as string },
    ];

    const result = messageRoleReversal(messages);

    expect(result).toEqual([
      { role: "assistant", content: "Valid message" },
      { role: "user", content: null },
      { role: "user", content: undefined },
      { role: "user", content: "" },
      { role: "assistant", content: ["text part"] },
    ]);
  });

  it("should preserve segments with tool messages unchanged", () => {
    const assistantWithToolCall = {
      role: "assistant" as const,
      content: [
        { type: "text", text: "I'll calculate that for you" },
        { type: "tool-call", toolCallId: "1", toolName: "calculator", args: { expression: "2+2" } }
      ]
    };

    const toolMessage = {
      role: "tool" as const,
      content: [{ type: "tool-result", toolCallId: "1", toolName: "calculator", result: 4 }]
    };

    const messages: CoreMessage[] = [
      { role: "user", content: "Calculate 2+2" },
      assistantWithToolCall as CoreMessage,
      toolMessage as CoreMessage,
      { role: "assistant", content: "The answer is 4" },
    ];

    const result = messageRoleReversal(messages);

    // Segment 1: [user, assistant+tool, tool] preserved due to tools
    // Segment 2: [assistant] gets reversed to user
    expect(result).toEqual([
      { role: "user", content: "Calculate 2+2" },
      assistantWithToolCall,
      toolMessage,
      { role: "user", content: "The answer is 4" }, // This gets reversed (new segment after tool)
    ]);
  });

  it("should handle multiple segments - preserve tool segments, reverse simple segments", () => {
    const assistantWithToolCall = {
      role: "assistant" as const,
      content: [{ type: "tool-call", toolCallId: "2", toolName: "calc", args: { expr: "5*6" } }]
    };

    const toolMessage = {
      role: "tool" as const,
      content: [{ type: "tool-result", toolCallId: "2", result: 30 }]
    };

    const messages: CoreMessage[] = [
      // Part of segment 1 (will be preserved due to tool interaction later)
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "What's 5*6?" },
      assistantWithToolCall as CoreMessage,
      toolMessage as CoreMessage,

      // Segment 2: Simple conversation (should be reversed)
      { role: "assistant", content: "The result is 30" },
      { role: "user", content: "Thanks!" },
    ];

    const result = messageRoleReversal(messages);

    expect(result).toEqual([
      // Segment 1: Entire conversation up to tool preserved unchanged
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "What's 5*6?" },
      assistantWithToolCall,
      toolMessage,

      // Segment 2: Reversed (new segment after tool)
      { role: "user", content: "The result is 30" },
      { role: "assistant", content: "Thanks!" },
    ]);
  });

  it("should preserve system messages unchanged", () => {
    const messages: CoreMessage[] = [
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
    const messages: CoreMessage[] = [];
    const result = messageRoleReversal(messages);
    expect(result).toEqual([]);
  });

  it("should handle segment with only tool messages", () => {
    const toolMessage = {
      role: "tool" as const,
      content: [{ type: "tool-result", toolCallId: "1", result: "test" }]
    };

    const messages: CoreMessage[] = [
      toolMessage as CoreMessage,
    ];

    const result = messageRoleReversal(messages);

    // Tool message should be preserved unchanged
    expect(result).toEqual(messages);
  });

  it("should handle assistant message with array content but no tool calls", () => {
    const assistantWithTextOnly = {
      role: "assistant" as const,
      content: [{ type: "text", text: "Just text content" }]
    };

    const messages: CoreMessage[] = [
      { role: "user", content: "Test" },
      assistantWithTextOnly as CoreMessage,
    ];

    const result = messageRoleReversal(messages);

    expect(result).toEqual([
      { role: "assistant", content: "Test" },
      assistantWithTextOnly,
    ]);
  });

  it("should create new segment after each tool message", () => {
    const toolMessage1 = {
      role: "tool" as const,
      content: [{ type: "tool-result", result: "result1" }]
    };

    const toolMessage2 = {
      role: "tool" as const,
      content: [{ type: "tool-result", result: "result2" }]
    };

    const messages: CoreMessage[] = [
      { role: "user", content: "First" },
      toolMessage1 as CoreMessage,
      { role: "user", content: "Second" },
      toolMessage2 as CoreMessage,
      { role: "user", content: "Third" },
    ];

    const result = messageRoleReversal(messages);

    expect(result).toEqual([
      // Segment 1: [user, tool] - preserved due to tool
      { role: "user", content: "First" },
      toolMessage1,
      // Segment 2: [user, tool] - preserved due to tool
      { role: "user", content: "Second" },
      toolMessage2,
      // Segment 3: [user] - reversed since no tools
      { role: "assistant", content: "Third" },
    ]);
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
    const longCriterion = "This is a very long criterion name that should be truncated because it exceeds the maximum length limit of seventy characters";
    const result = criterionToParamName(longCriterion);

    expect(result.length).toBe(70);
    expect(result).toBe("this_is_a_very_long_criterion_name_that_should_be_truncated_because_it");
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
