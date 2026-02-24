package scenario

import "context"

// Inference is the interface that LLM providers must implement.
type Inference interface {
	Inference(ctx context.Context, params InferenceParams) (*InferenceResult, error)
}

// InferenceParams holds parameters for an LLM inference request.
type InferenceParams struct {
	Model       string
	Messages    []Message
	Temperature *float64
	MaxTokens   *int64
	Tools       []ToolDefinition
	ToolChoice  *ToolChoice
}

// ToolDefinition describes a tool available to the model.
type ToolDefinition struct {
	Name        string
	Description string
	Parameters  map[string]any // JSON Schema
	Strict      bool
}

// ToolChoice controls which tool the model should use.
type ToolChoice struct {
	Type         string // "auto", "required", "function"
	FunctionName string // when Type == "function"
}

// InferenceResult holds the result of an LLM inference request.
type InferenceResult struct {
	Message Message
}
