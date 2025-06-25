import { MessagesSnapshotEvent } from '@ag-ui/core';
import { CoreMessage } from "ai";


import { generateMessageId } from "./ids";

type AgUiMessage = MessagesSnapshotEvent["messages"][number];

/**
 * Converts an array of CoreMessage (from 'ai') to an array of AG-UI compliant messages.
 * Handles splitting tool messages, extracting tool calls, and mapping/coercing fields.
 * @param coreMessages - Array of CoreMessage from 'ai'
 * @returns Array of AG-UI messages (user, assistant, system, tool)
 */
export function convertCoreMessagesToAguiMessages(coreMessages: CoreMessage[]): AgUiMessage[] {
  const aguiMessages: AgUiMessage[] = [];

  for (const msg of coreMessages) {
    const id = 'id' in msg && typeof msg.id === 'string' ? msg.id : generateMessageId();

    switch (true) {
      case msg.role === "system":
        aguiMessages.push({
          id: id,
          role: "system",
          content: msg.content,
        });
        break;

      case msg.role === "user" && typeof msg.content === 'string':
        aguiMessages.push({
          id: id,
          role: "user",
          content: msg.content,
        });
        break;

      // Handle any other user message content format
      case msg.role === "user" && Array.isArray(msg.content):
        aguiMessages.push({
          id: id,
          role: "user",
          content: JSON.stringify(msg.content),
        });
        break;

      case msg.role === "assistant" && typeof msg.content === 'string':
        aguiMessages.push({
          id: id,
          role: "assistant",
          content: msg.content,
        });
        break;

      case msg.role === "assistant" && Array.isArray(msg.content): {
        const toolCalls = msg.content.filter(p => p.type === "tool-call");
        const nonToolCalls = msg.content.filter(p => p.type !== "tool-call");

        aguiMessages.push({
          id: id,
          role: "assistant",
          content: JSON.stringify(nonToolCalls),
          toolCalls: toolCalls.map(c => ({
            id: c.toolCallId,
            type: "function",
            function: {
              name: c.toolName,
              arguments: JSON.stringify(c.args),
            },
          }))
        });

        break;
      }

      case msg.role === "tool":
        msg.content.map((p, i) => {
          aguiMessages.push({
            id: `${id}-${i}`,
            role: "tool",
            toolCallId: p.toolCallId,
            content: JSON.stringify(p.result),
          });
        });
        break;

      default:
        throw new Error(`Unsupported message role: ${msg.role}`);
    }
  }

  return aguiMessages;
}

export default convertCoreMessagesToAguiMessages;
