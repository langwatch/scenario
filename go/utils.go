package scenario

import (
	"fmt"
	"strings"
	"unicode"
)

func criterionNameToParamName(criterion string) string {
	// Remove all double quotes
	criterion = strings.ReplaceAll(criterion, "\"", "")

	// Replace all non-alphanumeric characters with underscores, and convert to lowercase as we go
	var result strings.Builder
	for _, r := range criterion {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			result.WriteRune(unicode.ToLower(r))
		} else {
			result.WriteRune('_')
		}
	}
	param := result.String()

	// Truncate to 70 characters
	if len(param) > 70 {
		param = param[:70]
	}

	return param
}

// messageRoleReversal swaps user<->assistant roles for the user simulator agent.
// Tool call messages are summarized as plain text. System messages are preserved.
func messageRoleReversal(messages []Message) []Message {
	var result []Message

	for _, msg := range messages {
		switch msg.Role {
		case MessageRoleTool:
			// Summarize tool result messages
			result = append(result, UserMsg(fmt.Sprintf("[Tool result: %s]", msg.Content)))

		case MessageRoleAssistant:
			if len(msg.ToolCalls) > 0 {
				// Summarize tool calls
				summary := summarizeToolCalls(msg)
				if summary != "" {
					result = append(result, UserMsg(summary))
				}
			} else {
				// Swap assistant -> user
				if msg.Content != "" {
					result = append(result, UserMsg(msg.Content))
				}
			}

		case MessageRoleUser:
			// Swap user -> assistant
			if msg.Content != "" {
				result = append(result, AssistantMsg(msg.Content))
			}

		default:
			// System and other messages preserved as-is
			result = append(result, msg)
		}
	}

	return result
}

// summarizeToolCalls summarizes tool call messages as plain text.
func summarizeToolCalls(msg Message) string {
	var summaries []string
	for _, tc := range msg.ToolCalls {
		summaries = append(summaries, fmt.Sprintf("[Called tool %s with: %s]", tc.Name, tc.Arguments))
	}
	return strings.Join(summaries, "\n")
}

