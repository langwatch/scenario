import { openai } from "@ai-sdk/openai";
import scenario, { type AgentAdapter, AgentRole } from "@langwatch/scenario";
import { generateText, tool, ToolCallPart } from "ai";
import { describe, it, expect } from "vitest";
import { z } from "zod";

// Define the LangWatch MCP tool
const getLangWatchMCP = tool({
  description: "Get the LangWatch integration code for a given project setup.",
  parameters: z.object({}),
  execute: async () => {
    return `from dotenv import load_dotenv

load_dotenv()

import chainlit as cl 
from openai import OpenAI
import langwatch

client = OpenAI()


@cl.on_message
@langwatch.trace()
async def main(message: cl.Message):
    langwatch.get_current_trace().autotrack_openai_calls(client)
    langwatch.get_current_trace().update(
        metadata={"labels": ["openai"]},
    )

    msg = cl.Message(
        content="",
    )

    completion = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {
                "role": "system",
                "content": "You are a helpful assistant that only reply in short tweet-like responses, using lots of emojis.",
            },
            {"role": "user", "content": message.content},
        ],
        stream=True,
        stream_options={"include_usage": True},
    )

    for part in completion:
        if len(part.choices) == 0:
            continue
        if token := part.choices[0].delta.content or "":
            await msg.stream_token(token)

    await msg.update()
`;
  },
});

// Claude Code Agent WIP, lots to do here
const claudeCodeAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  call: async (input) => {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    const userMessage = `--output-format json -p --dangerously-skip-permissions "add langwatch tracing to the is code: ${
      input.messages[input.messages.length - 1].content
    }"`;

    try {
      // Call Claude CLI with the user's message
      const { stdout, stderr } = await execAsync(
        `claude "${userMessage.replace(/"/g, '\\"')}"`
      );

      if (stderr) {
        return `Error calling Claude CLI: ${stderr}`;
      }

      return stdout.trim();
    } catch (error) {
      return `Failed to execute Claude CLI: ${
        error instanceof Error ? error.message : "Unknown error"
      }`;
    }
  },
};

const codeAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  call: async (input) => {
    const response = await generateText({
      model: openai("gpt-4.1"),
      messages: [
        {
          role: "system",
          content: `
            You are a helpful assistant that may help the user with code information on how to add LangWatch to their project. 
        Use the tools provided to help the user. Only respond with the code.           
          `,
        },
        ...input.messages,
      ],
      tools: { get_langwatch_mcp: getLangWatchMCP },
      toolChoice: "auto",
    });

    if (response.toolCalls && response.toolCalls.length > 0) {
      const toolCall = response.toolCalls[0];
      // Agent executes the tool directly and returns both messages
      const toolResult = await getLangWatchMCP.execute(toolCall.args, {
        toolCallId: toolCall.toolCallId,
        messages: input.messages,
      });
      return [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: toolCall.toolName,
              toolCallId: toolCall.toolCallId,
              args: toolCall.args,
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolName: toolCall.toolName,
              toolCallId: toolCall.toolCallId,
              result: toolResult,
            },
          ],
        },
      ];
    }

    return {
      role: "assistant",
      content: response.text,
    };
  },
};

describe("Code Agent", () => {
  it("should provide LangWatch integration code with proper imports and tracing", async () => {
    const result = await scenario.run({
      name: "LangWatch integration help",
      description: `
        The user has a Chainlit app and wants to add LangWatch tracing to it.
        They need help with the proper imports and decorators.
      `,
      agents: [
        codeAgent,
        scenario.userSimulatorAgent({ model: openai("gpt-4.1") }),
        scenario.judgeAgent({
          model: openai("gpt-4.1"),
          criteria: [
            "Agent should call the get_langwatch_mcp tool",
            "The response should include 'import langwatch'",
            "The response should include '@langwatch.trace()' decorator",
            "The code should show proper LangWatch integration",
          ],
        }),
      ],
      script: [
        scenario.user(`I have this app code:

from dotenv import load_dotenv

load_dotenv()

import chainlit as cl
from openai import OpenAI

client = OpenAI()


@cl.on_message
async def main(message: cl.Message):

    msg = cl.Message(
        content="",
    )

    completion = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {
                "role": "system",
                "content": "You are a helpful assistant that only reply in short tweet-like responses, using lots of emojis.",
            },
            {"role": "user", "content": message.content},
        ],
        stream=True,
        stream_options={"include_usage": True},
    )

    for part in completion:
        if len(part.choices) == 0:
            continue
        if token := part.choices[0].delta.content or "":
            await msg.stream_token(token)

    await msg.update()

How can I add LangWatch tracing to this?`),
        scenario.agent(),
        (state) => expect(state.hasToolCall("get_langwatch_mcp")).toBe(true),
        (state) => {
          // Check the tool result message which contains the LangWatch code
          const toolResult = state.lastToolCall("get_langwatch_mcp");
          const toolResultContent = toolResult.content[0];

          if (toolResultContent.type === "tool-result") {
            expect(toolResultContent.result).toContain("import langwatch");
            expect(toolResultContent.result).toContain("@langwatch.trace()");
          }
        },
        scenario.succeed(),
      ],
      setId: "javascript-examples",
    });

    expect(result.success).toBe(true);
  });

  it("should use Claude CLI to provide LangWatch integration help", async () => {
    const result = await scenario.run({
      name: "Claude CLI LangWatch integration",
      description: `
        The user wants to add LangWatch to their Chainlit app and is asking Claude CLI for help.
      `,
      agents: [
        claudeCodeAgent,
        scenario.userSimulatorAgent({ model: openai("gpt-4.1") }),
        scenario.judgeAgent({
          model: openai("gpt-4.1"),
          criteria: [
            "Agent should provide helpful guidance about LangWatch integration",
            "Response should be relevant to the user's Chainlit code",
            "Agent should not error out when calling Claude CLI",
          ],
        }),
      ],
      script: [
        scenario.user(
          "How can I add LangWatch tracing to my Chainlit application?"
        ),
        scenario.agent(),
        (state) => {
          const lastMessage = state.lastAgentMessage();
          const content =
            typeof lastMessage.content === "string" ? lastMessage.content : "";

          // Ensure Claude CLI didn't fail
          expect(content).not.toContain("Failed to execute Claude CLI");
          expect(content).not.toContain("Error calling Claude CLI");
        },
        scenario.succeed(),
      ],
      setId: "javascript-examples",
    });

    expect(result.success).toBe(true);
  });
});
