package claudecode

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

// benchTranscript is a typical agentic run: init, then rounds of thinking,
// text, a tool call and its result, rate-limit noise, and the result line.
func benchTranscript(rounds, resultBytes int) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	write := func(v any) { _ = enc.Encode(v) }
	write(map[string]any{"type": "system", "subtype": "init", "session_id": "0b9f7c8e-3d1a-4b6e-9f2a-7c5d8e1f0a3b", "cwd": "/tmp/project", "tools": []string{"Bash", "Read", "Write", "Edit"}, "model": "claude-sonnet-4-5"})
	const row = "drwxr-xr-x  12 user  staff   384 Oct 12 10:00 src\n"
	result := strings.Repeat(row, resultBytes/len(row)+1)[:resultBytes]
	for i := 0; i < rounds; i++ {
		write(map[string]any{"type": "assistant", "session_id": "s", "message": map[string]any{
			"id": "msg_01", "type": "message", "role": "assistant", "model": "claude-sonnet-4-5",
			"content": []any{
				map[string]any{"type": "thinking", "thinking": "I should list the files to see the layout first.", "signature": "EqQBCkYIBxgCKkA"},
				map[string]any{"type": "text", "text": "Let me look at the project structure — it matters for the next step."},
				map[string]any{"type": "tool_use", "id": "toolu_01ABC", "name": "Bash", "input": map[string]any{"command": "ls -la src", "description": "List the source directory"}},
			},
			"usage": map[string]any{"input_tokens": 1200, "output_tokens": 80},
		}})
		write(map[string]any{"type": "user", "session_id": "s", "message": map[string]any{"role": "user", "content": []any{
			map[string]any{"type": "tool_result", "tool_use_id": "toolu_01ABC", "content": result, "is_error": false},
		}}})
		write(map[string]any{"type": "rate_limit_event", "rate_limit_info": map[string]any{"status": "allowed"}})
	}
	write(map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "Done."}}}})
	write(map[string]any{"type": "result", "subtype": "success", "is_error": false, "session_id": "s", "result": "Done.", "num_turns": rounds})
	return b.Bytes()
}

func benchmarkParse(b *testing.B, data []byte) {
	b.ReportAllocs()
	b.SetBytes(int64(len(data)))
	for b.Loop() {
		if _, err := ParseStreamJSON(bytes.NewReader(data), Limits{}, nil); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkParseStreamJSON measures a 20-round run with 2 KB tool results.
func BenchmarkParseStreamJSON(b *testing.B) { benchmarkParse(b, benchTranscript(20, 2048)) }

// BenchmarkParseStreamJSONLargeToolResult measures one 256 KB tool result,
// capped to 8000 characters.
func BenchmarkParseStreamJSONLargeToolResult(b *testing.B) {
	benchmarkParse(b, benchTranscript(1, 256<<10))
}

// BenchmarkParseLine measures one assistant line with a tool call.
func BenchmarkParseLine(b *testing.B) {
	line := []byte(`{"type":"assistant","session_id":"s","message":{"role":"assistant","content":[{"type":"text","text":"Let me look at the project structure."},{"type":"tool_use","id":"toolu_01ABC","name":"Bash","input":{"command":"ls -la src"}}]}}`)
	b.ReportAllocs()
	b.SetBytes(int64(len(line)))
	for b.Loop() {
		p := newParser(Limits{}, nil)
		p.parseLine(line)
	}
}

// BenchmarkFormatPrompt measures flattening a 20-message conversation.
func BenchmarkFormatPrompt(b *testing.B) {
	var history []scenario.Message
	for i := 0; i < 5; i++ {
		history = append(history,
			scenario.UserMsg("Please refactor the parser and keep the public API stable."),
			scenario.Message{Role: scenario.RoleAssistant, Content: "On it.", ToolCalls: []scenario.ToolCall{{ID: "c", Name: "Bash", Arguments: `{"command":"go test ./..."}`}}},
			scenario.ToolMsg("c", "ok  \tgithub.com/x/y\t0.3s"),
			scenario.AssistantMsg("Refactored; all tests pass."),
		)
	}
	resolve := toolNameResolver(history)
	b.ReportAllocs()
	for b.Loop() {
		_ = formatPrompt(history, resolve)
	}
}
