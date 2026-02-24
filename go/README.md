# Scenario Go SDK

![scenario](https://github.com/langwatch/scenario/raw/refs/heads/main/assets/scenario-wide.webp)

A powerful Go library for testing AI agents in realistic, scripted scenarios.

Scenario provides a declarative DSL for defining test cases, allowing you to control conversation flow, simulate user behavior, and evaluate agent performance against predefined criteria.

## Features

- **Provider Agnostic** — works with any LLM provider through a simple `Inference` interface
- **Scenario-Based Testing** — define multi-turn conversation scenarios with user simulators and judges
- **Scripted Conversations** — fine-grained control over conversation flow with `User()`, `Agent()`, `Judge()`, `Proceed()`
- **LangWatch Integration** — real-time monitoring and trace reporting
- **Testing Integration** — use with `go test` for CI/CD pipelines

## Installation

```bash
go get github.com/langwatch/scenario/go
```

## Quick Start

```go
package myagent_test

import (
	"context"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

// echoAgent implements scenario.AgentAdapter.
type echoAgent struct{}

func (a *echoAgent) Role() scenario.AgentRole { return scenario.AgentRoleAgent }
func (a *echoAgent) Call(ctx context.Context, input scenario.AgentInput) (*scenario.AgentReturn, error) {
	lastMsg := input.Messages[len(input.Messages)-1]
	return scenario.NewStringAgentReturn("You said: " + lastMsg.Content), nil
}

func TestEchoAgent(t *testing.T) {
	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "Echo Agent Test",
		Description: "The agent should echo back the user's message.",
		Agents:      []scenario.AgentAdapter{&echoAgent{}},
		Script: []scenario.ScriptStep{
			scenario.User("Hello world!"),
			scenario.Agent(),
			scenario.Succeed("Agent correctly echoed the message."),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success {
		t.Fatalf("scenario failed: %v", *result.Reasoning)
	}
}
```

## Advanced Example

A weather agent with tool calls, a user simulator, and a judge with criteria:

```go
package myagent_test

import (
	"context"
	"testing"

	scenario "github.com/langwatch/scenario/go"
	scenarioOpenAI "github.com/langwatch/scenario/go/providers/openai"
	"github.com/openai/openai-go"
)

func TestWeatherAgent(t *testing.T) {
	client := openai.NewClient() // uses OPENAI_API_KEY
	llm := scenarioOpenAI.NewProvider(&client)

	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "Weather agent test",
		Description: "User asks about the weather in Tokyo and the agent uses the weather tool to respond",
		Agents: []scenario.AgentAdapter{
			&weatherAgent{}, // your agent under test
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{
				AgentConfig: scenario.AgentConfig{
					Model: "gpt-4o-mini",
					LLM:   llm,
				},
			}),
			scenario.NewJudgeAgent(scenario.JudgeAgentConfig{
				AgentConfig: scenario.AgentConfig{
					Model: "gpt-4o-mini",
					LLM:   llm,
				},
				Criteria: []string{
					"Agent uses the get_weather tool",
					"Agent provides the weather information to the user",
				},
			}),
		},
		Script: []scenario.ScriptStep{
			scenario.User("What's the weather like in Tokyo?"),
			scenario.Agent(),
			// Custom assertion as a script step
			func(ctx context.Context, exec scenario.Execution, state scenario.ExecutionState) (*scenario.ScenarioResult, error) {
				if !state.HasToolCall("get_weather") {
					return exec.Fail(ctx, "Agent did not call get_weather tool")
				}
				return nil, nil
			},
			scenario.Proceed(),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success {
		t.Fatalf("scenario failed: %v", *result.Reasoning)
	}
}
```

## Core Concepts

### `Run()`

The main entry point. Takes a `ScenarioConfig` and optional `RunOption`s:

```go
result, err := scenario.Run(ctx, scenario.ScenarioConfig{
	Name:        "My test",
	Description: "Description of what's being tested",
	Agents:      []scenario.AgentAdapter{...},
	Script:      []scenario.ScriptStep{...},
	MaxTurns:    10, // default: 10
})
```

### `AgentAdapter` Interface

Every agent implements this interface:

```go
type AgentAdapter interface {
	Role() AgentRole  // AgentRoleAgent, AgentRoleUser, or AgentRoleJudge
	Call(ctx context.Context, input AgentInput) (*AgentReturn, error)
}
```

### Built-in Agents

- **`NewUserSimulatorAgent(cfg)`** — LLM-powered user simulator that generates realistic user messages based on the scenario description
- **`NewJudgeAgent(cfg)`** — LLM-powered judge that evaluates the conversation against criteria

### Script Steps

| Step | Description |
|------|-------------|
| `User("message")` | Inject a user message |
| `User()` | Call the user simulator agent |
| `Agent("message")` | Inject an agent message |
| `Agent()` | Call the agent under test |
| `Judge()` | Call the judge for evaluation |
| `Judge(WithJudgeCriteria(...))` | Judge with inline criteria (checkpoint) |
| `Proceed()` | Auto-run turns until the judge decides |
| `Proceed(WithProceedTurns(n))` | Auto-run for n turns |
| `Succeed("reason")` | End the scenario as passed |
| `Fail("reason")` | End the scenario as failed |

Custom script steps are just functions:

```go
func(ctx context.Context, exec scenario.Execution, state scenario.ExecutionState) (*scenario.ScenarioResult, error) {
	if state.HasToolCall("my_tool") {
		return nil, nil // continue
	}
	return exec.Fail(ctx, "Expected tool call not found")
}
```

## Providers

The SDK uses a `Inference` interface for LLM calls. Provider packages adapt specific SDKs:

### OpenAI

```bash
go get github.com/langwatch/scenario/go/providers/openai
```

```go
import (
	scenarioOpenAI "github.com/langwatch/scenario/go/providers/openai"
	"github.com/openai/openai-go"
)

client := openai.NewClient() // uses OPENAI_API_KEY env var
llm := scenarioOpenAI.NewProvider(&client)
```

### Anthropic

```bash
go get github.com/langwatch/scenario/go/providers/anthropic
```

```go
import (
	scenarioAnthropic "github.com/langwatch/scenario/go/providers/anthropic"
	"github.com/anthropics/anthropic-sdk-go"
)

client := anthropic.NewClient() // uses ANTHROPIC_API_KEY env var
llm := scenarioAnthropic.NewProvider(&client)
```

### Gemini

```bash
go get github.com/langwatch/scenario/go/providers/gemini
```

```go
import (
	scenarioGemini "github.com/langwatch/scenario/go/providers/gemini"
	"google.golang.org/genai"
)

client, _ := genai.NewClient(ctx, &genai.ClientConfig{
	APIKey:  os.Getenv("GEMINI_API_KEY"),
	Backend: genai.BackendGoogleAI,
})
llm := scenarioGemini.NewProvider(client)
```

### AWS Bedrock

```bash
go get github.com/langwatch/scenario/go/providers/bedrock
```

```go
import (
	scenarioBedrock "github.com/langwatch/scenario/go/providers/bedrock"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
)

cfg, _ := config.LoadDefaultConfig(ctx)
client := bedrockruntime.NewFromConfig(cfg)
llm := scenarioBedrock.NewProvider(client)
```

### Custom Provider

Implement the `Inference` interface for any provider:

```go
type Inference interface {
	Inference(ctx context.Context, params InferenceParams) (*InferenceResult, error)
}
```

## LangWatch Integration

Set environment variables to enable real-time trace reporting:

```bash
export LANGWATCH_API_KEY="your-api-key"
export LANGWATCH_ENDPOINT="https://app.langwatch.ai"
```

Or configure programmatically:

```go
scenario.Run(ctx, cfg,
	scenario.WithEndpoint("https://app.langwatch.ai"),
	scenario.WithAPIKey("your-api-key"),
	scenario.WithBatchRunID("my-batch"),
)
```

Additional environment variables:
- `SCENARIO_BATCH_RUN_ID` — group runs across test files into a single batch

### SetID Grouping

Group related scenarios with `SetID` to view them together in LangWatch:

```go
scenario.Run(ctx, scenario.ScenarioConfig{
	SetID: "weather-agent-tests",
	// ...
})
```

## Testing Integration

Use with `go test`:

```go
func TestMyAgent(t *testing.T) {
	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "Agent handles refund request",
		Description: "A customer asks for a refund and the agent processes it correctly",
		Agents: []scenario.AgentAdapter{
			&myAgent{},
			scenario.NewUserSimulatorAgent(userSimCfg),
			scenario.NewJudgeAgent(judgeCfg),
		},
		Script: []scenario.ScriptStep{
			scenario.Proceed(),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success {
		t.Fatalf("scenario failed: %v", *result.Reasoning)
	}
}
```

```bash
go test ./... -v
```

## License

MIT
