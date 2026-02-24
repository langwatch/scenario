package scenario

// MessageRole represents the role of a message sender.
type MessageRole string

const (
	MessageRoleSystem    MessageRole = "system"
	MessageRoleUser      MessageRole = "user"
	MessageRoleAssistant MessageRole = "assistant"
	MessageRoleTool      MessageRole = "tool"
)

// Message is a provider-agnostic chat message.
type Message struct {
	Role       MessageRole `json:"role"`
	Content    string      `json:"content"`
	ToolCalls  []ToolCall  `json:"tool_calls,omitempty"`
	ToolCallID string      `json:"tool_call_id,omitempty"`
}

// ToolCall represents a tool/function call made by the assistant.
type ToolCall struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// SystemMsg creates a system message.
func SystemMsg(content string) Message {
	return Message{Role: MessageRoleSystem, Content: content}
}

// UserMsg creates a user message.
func UserMsg(content string) Message {
	return Message{Role: MessageRoleUser, Content: content}
}

// AssistantMsg creates an assistant message.
func AssistantMsg(content string) Message {
	return Message{Role: MessageRoleAssistant, Content: content}
}

// ToolMsg creates a tool result message.
func ToolMsg(toolCallID string, content string) Message {
	return Message{Role: MessageRoleTool, Content: content, ToolCallID: toolCallID}
}
