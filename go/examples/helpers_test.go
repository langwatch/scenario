package examples

import (
	"context"
	"fmt"
	"math/rand"

	scenario "github.com/langwatch/scenario/go"
	scenarioOpenAI "github.com/langwatch/scenario/go/providers/openai"
	"github.com/openai/openai-go"
)

// newLLM creates an OpenAI-backed Inference provider for testing agents.
func newLLM() scenario.Inference {
	client := openai.NewClient() // uses OPENAI_API_KEY
	return scenarioOpenAI.NewProvider(&client)
}

// simpleAgent creates an AgentAdapter that calls the OpenAI chat API with
// the given system prompt and optional tool definitions.
func simpleAgent(systemPrompt string, tools []scenario.ToolDefinition, toolExecutor func(tc scenario.ToolCall) (string, error)) scenario.AgentAdapter {
	return &funcAgent{
		systemPrompt: systemPrompt,
		tools:        tools,
		toolExecutor: toolExecutor,
	}
}

type funcAgent struct {
	systemPrompt string
	tools        []scenario.ToolDefinition
	toolExecutor func(tc scenario.ToolCall) (string, error)
}

func (a *funcAgent) Role() scenario.AgentRole { return scenario.AgentRoleAgent }

func (a *funcAgent) Call(ctx context.Context, input scenario.AgentInput) (*scenario.AgentReturn, error) {
	llm := newLLM()

	messages := []scenario.Message{scenario.SystemMsg(a.systemPrompt)}
	messages = append(messages, input.Messages...)

	return a.callWithMessages(ctx, llm, messages, nil)
}

func (a *funcAgent) callWithMessages(ctx context.Context, llm scenario.Inference, messages []scenario.Message, collected []scenario.Message) (*scenario.AgentReturn, error) {
	params := scenario.InferenceParams{
		Model:    "gpt-4.1-mini",
		Messages: messages,
	}
	if len(a.tools) > 0 {
		params.Tools = a.tools
		params.ToolChoice = &scenario.ToolChoice{Type: "auto"}
	}

	result, err := llm.Inference(ctx, params)
	if err != nil {
		return nil, err
	}

	// If the model made tool calls, execute them and recurse
	if len(result.Message.ToolCalls) > 0 && a.toolExecutor != nil {
		toolCallMsg := scenario.Message{
			Role:      scenario.MessageRoleAssistant,
			ToolCalls: result.Message.ToolCalls,
			Content:   result.Message.Content,
		}
		responseMessages := []scenario.Message{toolCallMsg}

		for _, tc := range result.Message.ToolCalls {
			toolResult, err := a.toolExecutor(tc)
			if err != nil {
				toolResult = fmt.Sprintf("Error: %v", err)
			}
			responseMessages = append(responseMessages, scenario.ToolMsg(tc.ID, toolResult))
		}

		allMessages := append(messages, responseMessages...)
		return a.callWithMessages(ctx, llm, allMessages, append(collected, responseMessages...))
	}

	// Return all collected intermediate messages plus the final text response
	if len(collected) > 0 {
		finalMsg := scenario.AssistantMsg(result.Message.Content)
		return scenario.NewMessagesAgentReturn(append(collected, finalMsg)), nil
	}

	return scenario.NewStringAgentReturn(result.Message.Content), nil
}

// simulateWeather returns a random weather string for a city.
func simulateWeather(city string) string {
	choices := []string{"sunny", "cloudy", "rainy", "snowy"}
	temp := rand.Intn(31)
	weather := choices[rand.Intn(len(choices))]
	return fmt.Sprintf("The weather in %s is %s with a temperature of %d°C.", city, weather, temp)
}
