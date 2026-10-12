package claudecode

import (
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

func TestFormatPromptRendersEveryKindOfContent(t *testing.T) {
	history := []scenario.Message{
		scenario.SystemMsg("be brief"),
		scenario.UserMsg("hi"),
		{Role: scenario.RoleAssistant, Content: "checking", ToolCalls: []scenario.ToolCall{
			{ID: "c1", Name: "search", Arguments: `{"q": "x", "n": 1.0}`},
			{ID: "c2", Name: "noargs"},
			{ID: "c3", Name: "bad", Arguments: "not json"},
		}},
		scenario.ToolMsg("c1", `{"hits": [1]}`),
		{Role: scenario.RoleTool, ToolCallID: "c2", ToolName: "noargs", Content: "plain"},
		scenario.ToolMsg("zz", "orphan"),
		{Role: scenario.RoleUser, Parts: []scenario.Part{
			scenario.TextPart("look"),
			scenario.ImageURLPart("https://x/y.png"),
			scenario.ImagePart("image/png", []byte{1, 2}),
			scenario.FilePart("", []byte{1}, "f"),
			scenario.AudioPart("audio/wav", []byte{1}),
			{Type: "reasoning", Raw: []byte(`{"type":"reasoning","text":"thought"}`)},
			{Type: "custom", Raw: []byte(`{"type":"custom","k":1}`)},
			{Type: "bare"},
			scenario.TextPart(""),
		}},
	}
	got := formatPrompt(history, toolNameResolver(history))
	want := "system: be brief\n\n" +
		"user: hi\n\n" +
		"assistant: checking\n[tool-call: search({\"q\":\"x\",\"n\":1})]\n[tool-call: noargs({})]\n[tool-call: bad(\"not json\")]\n\n" +
		"tool: [tool-result: search -> {\"type\":\"json\",\"value\":{\"hits\":[1]}}]\n\n" +
		"tool: [tool-result: noargs -> {\"type\":\"text\",\"value\":\"plain\"}]\n\n" +
		"tool: [tool-result: unknown -> {\"type\":\"text\",\"value\":\"orphan\"}]\n\n" +
		"user: look\n{\"type\":\"image\",\"image\":\"https://x/y.png\"}\n{\"type\":\"image\",\"image\":\"AQI=\",\"mediaType\":\"image/png\"}\n" +
		"[file: application/octet-stream]\n[file: audio/wav]\nthought\n{\"type\":\"custom\",\"k\":1}\n{\"type\":\"bare\"}"
	if got != want {
		t.Fatalf("prompt:\n%s\nwant:\n%s", got, want)
	}
}

func TestHasRenderableContent(t *testing.T) {
	for prompt, want := range map[string]bool{
		"":                            false,
		"user: ":                      false,
		"user:   \n\nassistant: ":     false,
		"user: hi":                    true,
		"user: \n\nassistant: there":  true,
		"user: a: b":                  true,
		"no label at all":             true,
		"user: [tool-call: x({})]":    true,
		"tool: \n  continued content": true,
	} {
		if got := hasRenderableContent(prompt); got != want {
			t.Errorf("hasRenderableContent(%q) = %v", prompt, got)
		}
	}
}
