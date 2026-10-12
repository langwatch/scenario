# providers/gemini

Google Gemini (Gemini API and Vertex AI) for the Scenario Go SDK, through
`google.golang.org/genai`.

```bash
go get github.com/langwatch/scenario/go/providers/gemini
```

## With your own client

```go
client, err := genai.NewClient(ctx, &genai.ClientConfig{}) // GEMINI_API_KEY or GOOGLE_API_KEY
model := scenario.ModelConfig{LLM: scenariogemini.NewProvider(client), Model: "gemini-2.5-flash"}
```

## Model strings

```go
scenariogemini.Register() // gemini/, google/ and vertex_ai/
model := scenario.ModelConfig{Model: "gemini/gemini-2.5-flash"}
```

| Name | Backend | Configuration |
|------|---------|---------------|
| `gemini`, `google` | Gemini API | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| `vertex_ai` | Vertex AI | Application Default Credentials, `GOOGLE_CLOUD_PROJECT` (or `VERTEXAI_PROJECT`), `GOOGLE_CLOUD_LOCATION` (or `VERTEXAI_LOCATION`) |

`ModelConfig.APIKey`, `BaseURL` and `Headers` override the environment.

## Streaming your agent

```go
res, err := provider.Stream(ctx, scenario.InferenceParams{Model: "gemini-2.5-flash", Messages: in.Messages}, in.Stream)
```

`Stream` forwards text deltas to `AgentInput.Stream`, and each function call
as start, arguments and end (Gemini sends calls whole), then returns the
final message, the one to return from your agent.
`StreamGenerateContent(ctx, client, model, contents, cfg, in.Stream)` does
the same for contents you built yourself and returns the chunks merged into
one `genai.GenerateContentResponse`. Both work with a nil stream (granular
events off).

Tool results built with `scenario.ToolMsg` carry no tool name; the name
Gemini needs is taken from the assistant tool call with the same id.
