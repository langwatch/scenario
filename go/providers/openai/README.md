# providers/openai

OpenAI Chat Completions for the Scenario Go SDK, also covering Azure OpenAI
and OpenAI-compatible servers.

```bash
go get github.com/langwatch/scenario/go/providers/openai
```

## With your own client

```go
client := openai.NewClient() // OPENAI_API_KEY
model := scenario.ModelConfig{LLM: scenarioopenai.NewProvider(&client), Model: "gpt-4.1-mini"}
```

## Model strings

`scenarioopenai.Register()` registers every name below; or register one with
`scenario.RegisterProvider("openai", scenarioopenai.Factory)`. Then
`scenario.ModelConfig{Model: "<name>/<model>"}` works anywhere a model is
taken. `ModelConfig.APIKey`, `BaseURL` and `Headers` override the
environment.

| Name (aliases) | Address | Key | Address override |
|----------------|---------|-----|------------------|
| `openai` | api.openai.com | `OPENAI_API_KEY` | `OPENAI_BASE_URL` |
| `azure` | your resource | `AZURE_API_KEY`, `AZURE_OPENAI_API_KEY` | `AZURE_API_BASE`, `AZURE_OPENAI_ENDPOINT`, `AZURE_RESOURCE_NAME` |
| `openrouter` | openrouter.ai/api/v1 | `OPENROUTER_API_KEY` | `OPENROUTER_API_BASE` |
| `ollama` | localhost:11434/v1 | none (`OLLAMA_API_KEY`) | `OLLAMA_API_BASE`, `OLLAMA_BASE_URL`, `OLLAMA_HOST` |
| `groq` | api.groq.com/openai/v1 | `GROQ_API_KEY` | `GROQ_API_BASE` |
| `together_ai` (`together`) | api.together.xyz/v1 | `TOGETHER_API_KEY`, `TOGETHERAI_API_KEY`, `TOGETHER_AI_API_KEY` | `TOGETHER_API_BASE` |
| `hosted_vllm` (`vllm`) | localhost:8000/v1 | none (`HOSTED_VLLM_API_KEY`, `VLLM_API_KEY`) | `HOSTED_VLLM_API_BASE`, `VLLM_API_BASE` |
| `litellm_proxy` (`litellm`) | localhost:4000 | none (`LITELLM_PROXY_API_KEY`, `LITELLM_API_KEY`) | `LITELLM_PROXY_API_BASE` |
| `mistral` | api.mistral.ai/v1 | `MISTRAL_API_KEY` | `MISTRAL_API_BASE` |
| `deepseek` | api.deepseek.com/v1 | `DEEPSEEK_API_KEY` | `DEEPSEEK_API_BASE` |
| `xai` | api.x.ai/v1 | `XAI_API_KEY` | `XAI_API_BASE` |
| `fireworks_ai` (`fireworks`) | api.fireworks.ai/inference/v1 | `FIREWORKS_AI_API_KEY`, `FIREWORKS_API_KEY` | `FIREWORKS_AI_API_BASE` |

The names and variables follow LiteLLM, which the Python SDK uses, so
`"ollama/llama3.2"`, `"openrouter/anthropic/claude-sonnet-4.5"` or
`"hosted_vllm/meta-llama/Llama-3.1-8B-Instruct"` mean the same in every SDK.
Clients for servers other than OpenAI ignore the `OPENAI_*` variables, so an
OpenAI key is never sent elsewhere. Ollama, vLLM, Together, Mistral, DeepSeek
and Fireworks get `max_tokens` and no `stream_options`
(`Provider.LegacyParams`), the fields every compatible server accepts.

### Azure OpenAI

The model is the deployment name: `"azure/my-gpt-4o"`. The API version
(`AZURE_API_VERSION`, `OPENAI_API_VERSION`, `AzureConfig.APIVersion`, or an
`?api-version=` query on the endpoint) picks the API:

- empty, `v1`, `latest` or `preview`: the v1 API, `<endpoint>/openai/v1`;
- a dated version such as `2024-10-21`: the deployments API,
  `<endpoint>/openai/deployments/<deployment>?api-version=…`.

Requests authenticate with the `api-key` header. `scenarioopenai.NewAzure(AzureConfig{...})`
builds the provider directly. For Microsoft Entra ID, build a client with
openai-go's `azure` package and wrap it with `NewProvider`.

### Mistral

There is no official Mistral Go SDK, so Mistral is served through its
OpenAI-compatible API: `"mistral/mistral-large-latest"` with
`MISTRAL_API_KEY`.

### Other compatible servers

```go
scenario.RegisterProvider("gateway", scenarioopenai.CompatibleFactory(scenarioopenai.Endpoint{
	BaseURL:   "https://gateway.internal/v1",
	APIKeyEnv: []string{"GATEWAY_API_KEY"},
}))
```

## Streaming your agent

```go
res, err := provider.Stream(ctx, scenario.InferenceParams{Model: "gpt-4.1-mini", Messages: in.Messages}, in.Stream)
```

`Stream` forwards text deltas and tool call start, arguments and end to
`AgentInput.Stream` and returns the final message, the one to return from
your agent. `StreamChatCompletion(ctx, client, req, in.Stream)` does the
same for an `openai.ChatCompletionNewParams` you built yourself and returns
the accumulated `openai.ChatCompletion`. Both work with a nil stream
(granular events off).
