# providers/bedrock

AWS Bedrock Converse API for the Scenario Go SDK.

```bash
go get github.com/langwatch/scenario/go/providers/bedrock
```

## With your own client

```go
cfg, err := config.LoadDefaultConfig(ctx)
model := scenario.ModelConfig{LLM: scenariobedrock.NewProvider(bedrockruntime.NewFromConfig(cfg)), Model: "anthropic.claude-3-5-sonnet-20240620-v1:0"}
```

## Model strings

```go
scenariobedrock.Register() // or scenario.RegisterProvider("bedrock", scenariobedrock.Factory)
model := scenario.ModelConfig{Model: "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0"}
```

Credentials and region come from the AWS default chain: `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, `AWS_REGION`,
SSO, instance and task roles. LiteLLM's `AWS_REGION_NAME` is used when no
AWS region is set. A Bedrock API key goes in `AWS_BEARER_TOKEN_BEDROCK` or
`ModelConfig.APIKey`; `BaseURL` overrides the endpoint and `Headers` are
added to every request.

## Streaming your agent

```go
res, err := provider.Stream(ctx, scenario.InferenceParams{Model: modelID, Messages: in.Messages}, in.Stream)
```

`Stream` forwards text deltas and tool use start, input and end to
`AgentInput.Stream` and returns the final message, the one to return from
your agent. `StreamConverse(ctx, client, input, in.Stream)` does the same for
a `bedrockruntime.ConverseStreamInput` you built yourself and returns the
accumulated `types.Message`, stop reason and usage. Both work with a nil
stream (granular events off).
