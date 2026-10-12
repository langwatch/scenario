# Scenario Go SDK

![scenario](https://github.com/langwatch/scenario/raw/refs/heads/main/assets/scenario-wide.webp)

Test AI agents with simulated users and an LLM judge, in realistic, scripted
multi-turn scenarios. The Go SDK follows the JavaScript SDK: same script DSL,
same judge, same events and traces in [LangWatch](https://langwatch.ai).

## Features

- **Provider agnostic**: any model behind the small `scenario.LLM` interface;
  adapters for OpenAI, Anthropic, Gemini and Bedrock in separate modules
- **Scripted or simulated conversations**: `User()`, `Agent()`, `Judge()`,
  `Proceed()`, `Succeed()`, `Fail()` and your own steps
- **Two-phase judge** with a verdict per criterion (passed, failed,
  inconclusive), reading both the transcript and the OpenTelemetry spans of
  your agent
- **Multimodal messages**: text, images, files and audio
- **LangWatch**: live events and traces of every run
- **`go test` native**: runs are independent and safe under `t.Parallel()`

## Installation

```bash
go get github.com/langwatch/scenario/go
go get github.com/langwatch/scenario/go/providers/openai   # or anthropic, gemini, bedrock
```

## Quick start

```go
package myagent_test

import (
	"context"
	"testing"

	"github.com/openai/openai-go/v3"
	scenario "github.com/langwatch/scenario/go"
	scenarioopenai "github.com/langwatch/scenario/go/providers/openai"
)

func TestGreeting(t *testing.T) {
	t.Parallel()
	client := openai.NewClient() // OPENAI_API_KEY
	model := scenario.ModelConfig{LLM: scenarioopenai.NewProvider(&client), Model: "gpt-4.1-mini"}

	agent := scenario.AgentFunc(func(ctx context.Context, in scenario.AgentInput) (*scenario.AgentReturn, error) {
		return scenario.TextReturn("Hello! How can I help you today?"), nil
	})

	result, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "greeting",
		Description: "The user says hello to a customer support agent",
		Agents: []scenario.AgentAdapter{
			agent,
			scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: model}),
			scenario.NewJudgeAgent(scenario.JudgeAgentConfig{
				ModelConfig: model,
				Criteria:    []string{"The agent greets the user", "The agent offers help"},
			}),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Success {
		t.Fatalf("scenario failed: %s", result.Reasoning)
	}
}
```

Without a script the scenario runs `Proceed()`: the user simulator, your
agent and the judge take turns until the judge decides or `MaxTurns` (10) is
reached.

Set a process-wide default model once instead of on every agent:

```go
scenario.Configure(scenario.WithDefaultModel(model))
```

## Scripts

```go
Script: []scenario.ScriptStep{
	scenario.User("i need to change my flight"), // fixed user message
	scenario.Agent(),                             // your agent answers
	scenario.User(),                              // the simulator writes the next message
	scenario.Agent(),
	scenario.StepFunc(func(ctx context.Context, ex *scenario.Executor) error {
		return scenario.Assert(ex.State().HasToolCall("lookup_booking"), "agent looked up the booking")
	}),
	scenario.Judge(scenario.WithCriteria("The agent asks for the booking reference")), // checkpoint
	scenario.Proceed(scenario.Turns(3)),
	scenario.Judge(), // final verdict on the judge's own criteria
},
```

| Step | Meaning |
|------|---------|
| `User(text...)` / `Agent(text...)` | add a fixed message, or let the simulator / your agent produce one |
| `MessageStep(msg)` | inject any message (tool calls, tool results, system) |
| `Judge(opts...)` | verdict now; `WithCriteria` makes it a checkpoint, `WithAdditionalContext` adds evidence |
| `Proceed(Turns(n), OnTurn(f), OnStep(f))` | let the agents converse |
| `Succeed(reason)` / `Fail(reason)` | end the scenario |
| `StepFunc(fn)` | your own step; return `scenario.Assert(...)` for checks |

`ScriptStep` is an interface (`Run(ctx, *Executor) error`), so packages can
add their own steps.

## Agents

```go
type AgentAdapter interface {
	Role() AgentRole // AgentRoleAgent, AgentRoleUser or AgentRoleJudge
	Call(ctx context.Context, input AgentInput) (*AgentReturn, error)
}
```

`AgentInput` carries the conversation (`Messages`, `NewMessages`), the
thread id, the live `ScenarioState`, the config and `PropagationHeaders`
(W3C `traceparent`): forward them to an HTTP agent so its spans join the
scenario trace. Return `TextReturn`, `MessageReturn`, `MessagesReturn` (tool
calls and results) or, for judges, `VerdictReturn`. `NewConnectedAgent`
runs an agent written against the LangWatch connected-agent contract.

The built-in agents are `NewUserSimulatorAgent` (with an optional `Persona`)
and `NewJudgeAgent` (custom `SystemPrompt`, criteria, trace discovery
settings). `ScenarioConfig.MinTurns` keeps the judge from ending the test
early; an explicit `Judge()` and the last turn always get a verdict.

## Results

```go
result.Success
result.Reasoning
result.MetCriteria, result.UnmetCriteria, result.InconclusiveCriteria
result.Criteria        // per criterion: requirement, status, reasoning
result.ReachedMaxTurns // ended at the turn cap
result.Messages, result.TotalTime, result.AgentTime
```

`Run` returns an error for an invalid config, an agent failure or a failed
`Assert`; the result is still returned and reported in those cases.

## State views

Inside a step or an agent, `ex.State()` / `input.ScenarioState` offers
`Messages()`, `LastMessage()`, `LastUserMessage()`, `LastAgentMessage()`,
`LastToolCall(name)`, `HasToolCall(name)`, `FirstUserMessage()`,
`Transcript()`, `ToolCalls(name...)` (merged from messages and tool spans,
with `First`, `Last`, `Inputs`, `Outputs`), `Turns()`, `Traces()`, `Spans()`,
`Contexts()`, `Fields()` / `Field(name)` and `Criteria()`.

## Providers

| Module | Client | Registry names |
|--------|--------|----------------|
| [`providers/openai`](providers/openai) | `github.com/openai/openai-go/v3` | `openai`, `azure`, `openrouter`, `ollama`, `groq`, `together_ai`, `hosted_vllm`, `litellm_proxy`, `mistral`, `deepseek`, `xai`, `fireworks_ai` |
| [`providers/anthropic`](providers/anthropic) | `github.com/anthropics/anthropic-sdk-go` | `anthropic` |
| [`providers/gemini`](providers/gemini) | `google.golang.org/genai` | `gemini`, `google`, `vertex_ai` |
| [`providers/bedrock`](providers/bedrock) | `github.com/aws/aws-sdk-go-v2/service/bedrockruntime` | `bedrock` |

Each exposes `NewProvider(client)` plus message converters for your own
adapters. Any type with `Inference(ctx, InferenceParams) (*InferenceResult, error)`
is a `scenario.LLM`.

### Model strings

Like the JS and Python SDKs, a model can be a `"provider/model"` string.
Register the providers you use once (nothing is registered by default, so
importing the SDK sets up no client), then name models by string; API keys
come from the usual environment variables (`OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `AWS_*`, …):

```go
func TestMain(m *testing.M) {
	scenarioopenai.Register()    // openai/, azure/, openrouter/, ollama/, …
	scenarioanthropic.Register() // anthropic/
	// or one name at a time: scenario.RegisterProvider("openai", scenarioopenai.Factory)
	scenario.Configure(scenario.WithDefaultModel(scenario.ModelConfig{Model: "openai/gpt-4.1-mini"}))
	os.Exit(m.Run())
}

judge := scenario.NewJudgeAgent(scenario.JudgeAgentConfig{
	ModelConfig: scenario.ModelConfig{Model: "anthropic/claude-sonnet-4-5"},
	Criteria:    []string{"The agent offers help"},
})
```

The string splits at its first slash, so `"openrouter/anthropic/claude-sonnet-4.5"`
asks OpenRouter for `anthropic/claude-sonnet-4.5`. `ModelConfig.APIKey`,
`BaseURL` and `Headers` override the environment for one model. An agent's
model naming its own provider does not inherit the default `LLM`; a bare
model name (`"gpt-4.1"`) keeps the default's provider. Your own agents can
get a ready LLM with `scenario.ModelConfig{Model: "groq/llama-3.3-70b-versatile"}.Resolve()`.
`scenario.RegisterProvider(name, factory)` adds your own providers.

### Streaming your agent

When granular events are on (`SCENARIO_SEND_GRANULAR_EVENTS=1` or
`WithGranularEvents(true)`), `AgentInput.Stream` shows your agent's message
live in LangWatch. Each provider module has a helper that runs a streaming
completion, forwards text deltas and tool calls to it, and returns the final
message; `Stream` is nil, and the helpers still work, when granular events
are off:

```go
agent := scenario.AgentFunc(func(ctx context.Context, in scenario.AgentInput) (*scenario.AgentReturn, error) {
	res, err := provider.Stream(ctx, scenario.InferenceParams{Model: "gpt-4.1-mini", Messages: in.Messages}, in.Stream)
	if err != nil {
		return nil, err
	}
	return scenario.MessageReturn(res.Message), nil
})
```

`openai.StreamChatCompletion`, `anthropic.StreamMessage`,
`gemini.StreamGenerateContent` and `bedrock.StreamConverse` do the same for
requests built with the providers' own SDK types. The built-in user
simulator and judge do not stream.

## LangWatch

Set `LANGWATCH_API_KEY` (and `LANGWATCH_PROJECT_ID` for personal access
tokens) to stream each run to LangWatch; `LANGWATCH_ENDPOINT` selects a
self-hosted instance. Per run, `scenario.WithLangWatch(...)`,
`WithBatchRunID`, `WithRunID`, `WithHTTPClient` and the config's `SetID` /
`ThreadID` override everything without touching the environment.

Tracing is set up on the first run. To customize it, call
`scenario.SetupScenarioTracing(scenario.TracingOptions{...})` first (extra
processors, an exporter, `Filters: []langwatch.Filter{scenario.ScenarioOnly()}`).
An application that already set a global SDK `TracerProvider` keeps it: the
scenario span collector and exporter are attached to it. `FlushTracing` and
`ShutdownTracing` are available for process exit.

Group runs with `SetID`; all runs of one `go test ./...` invocation share a
batch (`SCENARIO_BATCH_RUN_ID` overrides it).

## Development

```bash
go vet ./... && go test -race ./...          # core
(cd providers/openai && go test -race ./...) # each provider
(cd examples && go vet ./...)                 # examples (need OPENAI_API_KEY to run)
go test -run TestGolden -update .             # regenerate testdata/events
```

## License

MIT
