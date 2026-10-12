# providers/anthropic

Anthropic Messages API for the Scenario Go SDK.

```bash
go get github.com/langwatch/scenario/go/providers/anthropic
```

## With your own client

```go
client := anthropic.NewClient() // ANTHROPIC_API_KEY
model := scenario.ModelConfig{LLM: scenarioanthropic.NewProvider(&client), Model: "claude-sonnet-4-5"}
```

Requests without a token limit get `DefaultMaxTokens` (4096); the Messages
API requires one.

## Model strings

```go
scenarioanthropic.Register() // or scenario.RegisterProvider("anthropic", scenarioanthropic.Factory)
model := scenario.ModelConfig{Model: "anthropic/claude-sonnet-4-5"}
```

The key comes from `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) and the
address from `ANTHROPIC_BASE_URL`; `ModelConfig.APIKey`, `BaseURL` and
`Headers` override them.

## Streaming your agent

```go
res, err := provider.Stream(ctx, scenario.InferenceParams{Model: "claude-sonnet-4-5", Messages: in.Messages}, in.Stream)
```

`Stream` forwards text deltas and tool use start, input and end to
`AgentInput.Stream` and returns the final message, the one to return from
your agent. `StreamMessage(ctx, client, req, in.Stream)` does the same for an
`anthropic.MessageNewParams` you built yourself and returns the accumulated
`anthropic.Message`. Both work with a nil stream (granular events off).
