package spandigest

import (
	"encoding/hex"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

type spanSpec struct {
	id, parent string
	name       string
	start, end time.Time
	attrs      []attribute.KeyValue
	events     []sdktrace.Event
	errMsg     string
}

func at(sec int64, ns int64) time.Time { return time.Unix(sec, ns) }

func mkSpans(specs ...spanSpec) []sdktrace.ReadOnlySpan {
	var tid trace.TraceID
	tid[0] = 1
	stubs := make(tracetest.SpanStubs, len(specs))
	for i, s := range specs {
		var sid, pid trace.SpanID
		b, _ := hex.DecodeString(s.id)
		copy(sid[:], b)
		st := tracetest.SpanStub{
			Name:        s.name,
			SpanContext: trace.NewSpanContext(trace.SpanContextConfig{TraceID: tid, SpanID: sid}),
			StartTime:   s.start, EndTime: s.end,
			Attributes: s.attrs, Events: s.events,
		}
		if s.parent != "" {
			b, _ := hex.DecodeString(s.parent)
			copy(pid[:], b)
			st.Parent = trace.NewSpanContext(trace.SpanContextConfig{TraceID: tid, SpanID: pid})
		}
		if s.errMsg != "" {
			st.Status = sdktrace.Status{Code: codes.Error, Description: s.errMsg}
		}
		stubs[i] = st
	}
	return stubs.Snapshots()
}

func check(t *testing.T, got, want string) {
	t.Helper()
	if got != want {
		t.Errorf("digest mismatch\n--- got\n%s\n--- want\n%s", got, want)
	}
}

// The expectations below are the JS SDK's inline snapshots
// (judge-span-digest-formatter.test.ts).

func TestFormatEmpty(t *testing.T) {
	check(t, Format(nil), "No spans recorded.")
	check(t, FormatStructureOnly(nil), "No spans recorded.")
}

func TestFormatSingleSpan(t *testing.T) {
	spans := mkSpans(spanSpec{id: "a1b2c3d4e5f67890", name: "llm.chat", start: at(1700000000, 0), end: at(1700000000, 500_000_000),
		attrs: []attribute.KeyValue{attribute.String("gen_ai.prompt", "Hello"), attribute.String("gen_ai.completion", "Hi there!"), attribute.String("model", "gpt-4")}})
	check(t, Format(spans), "Spans: 1 | Total Duration: 500ms\n\n[a1b2c3d4] 2023-11-14T22:13:20.000Z llm.chat (500ms)\n    gen_ai.prompt: Hello\n    gen_ai.completion: Hi there!\n    model: gpt-4\n")
}

func TestFormatOrdersByStart(t *testing.T) {
	spans := mkSpans(
		spanSpec{id: "bbbb000000000000", name: "second", start: at(1700000001, 0), end: at(1700000001, 100_000_000)},
		spanSpec{id: "aaaa000000000000", name: "first", start: at(1700000000, 0), end: at(1700000000, 200_000_000)},
		spanSpec{id: "cccc000000000000", name: "third", start: at(1700000002, 0), end: at(1700000002, 50_000_000)},
	)
	check(t, Format(spans), "Spans: 3 | Total Duration: 2.05s\n\n[aaaa0000] 2023-11-14T22:13:20.000Z first (200ms)\n\n[bbbb0000] 2023-11-14T22:13:21.000Z second (100ms)\n\n[cccc0000] 2023-11-14T22:13:22.000Z third (50ms)\n")
}

func TestFormatNesting(t *testing.T) {
	spans := mkSpans(
		spanSpec{id: "1111000000000000", name: "agent.run", start: at(1700000000, 0), end: at(1700000001, 0)},
		spanSpec{id: "2222000000000000", parent: "1111000000000000", name: "llm.call", start: at(1700000000, 100_000_000), end: at(1700000000, 500_000_000)},
		spanSpec{id: "3333000000000000", parent: "1111000000000000", name: "tool.execute", start: at(1700000000, 600_000_000), end: at(1700000000, 900_000_000)},
	)
	check(t, Format(spans), "Spans: 3 | Total Duration: 1.00s\n\n[11110000] 2023-11-14T22:13:20.000Z agent.run (1.00s)\n\n├── [22220000] 2023-11-14T22:13:20.100Z llm.call (400ms)\n\n└── [33330000] 2023-11-14T22:13:20.600Z tool.execute (300ms)\n")

	deep := mkSpans(
		spanSpec{id: "1111000000000000", name: "root", start: at(1700000000, 0), end: at(1700000002, 0)},
		spanSpec{id: "2222000000000000", parent: "1111000000000000", name: "level-1", start: at(1700000000, 100_000_000), end: at(1700000001, 900_000_000)},
		spanSpec{id: "3333000000000000", parent: "2222000000000000", name: "level-2", start: at(1700000000, 200_000_000), end: at(1700000001, 800_000_000)},
	)
	check(t, Format(deep), "Spans: 3 | Total Duration: 2.00s\n\n[11110000] 2023-11-14T22:13:20.000Z root (2.00s)\n\n└── [22220000] 2023-11-14T22:13:20.100Z level-1 (1.80s)\n\n│   └── [33330000] 2023-11-14T22:13:20.200Z level-2 (1.60s)\n")
}

func TestFormatJSONAttributesAreNormalized(t *testing.T) {
	spans := mkSpans(spanSpec{id: "aabb112233445566", name: "llm.chat", start: at(1700000000, 0), end: at(1700000000, 100_000_000),
		attrs: []attribute.KeyValue{
			attribute.String("gen_ai.prompt", "What is the weather in Paris?"),
			attribute.String("gen_ai.completion", "Let me check the weather for you."),
			attribute.String("tool.name", "get_weather"),
			attribute.String("tool.input", `{"city": "Paris"}`),
			attribute.String("tool.output", `{"temp": 22, "condition": "sunny"}`),
		}})
	check(t, Format(spans), "Spans: 1 | Total Duration: 100ms\n\n[aabb1122] 2023-11-14T22:13:20.000Z llm.chat (100ms)\n    gen_ai.prompt: What is the weather in Paris?\n    gen_ai.completion: Let me check the weather for you.\n    tool.name: get_weather\n    tool.input: {\"city\":\"Paris\"}\n    tool.output: {\"temp\":22,\"condition\":\"sunny\"}\n")
}

func TestFormatErrors(t *testing.T) {
	spans := mkSpans(
		spanSpec{id: "aaaa000000000000", name: "successful.operation", start: at(1700000000, 0), end: at(1700000000, 100_000_000)},
		spanSpec{id: "bbbb000000000000", name: "failed.operation", start: at(1700000000, 200_000_000), end: at(1700000000, 300_000_000), errMsg: "Connection refused"},
	)
	check(t, Format(spans), "Spans: 2 | Total Duration: 300ms\n\n[aaaa0000] 2023-11-14T22:13:20.000Z successful.operation (100ms)\n\n[bbbb0000] 2023-11-14T22:13:20.200Z failed.operation (100ms) ⚠️ ERROR: Connection refused\n\n\n=== ERRORS ===\n- failed.operation: Connection refused")
}

func TestFormatEvents(t *testing.T) {
	spans := mkSpans(spanSpec{id: "aabb112233445566", name: "llm.stream", start: at(1700000000, 0), end: at(1700000001, 0),
		events: []sdktrace.Event{
			{Name: "token.generated", Attributes: []attribute.KeyValue{attribute.String("token", "Hello"), attribute.Int("index", 0)}},
			{Name: "token.generated", Attributes: []attribute.KeyValue{attribute.String("token", " world"), attribute.Int("index", 1)}},
		}})
	check(t, Format(spans), "Spans: 1 | Total Duration: 1.00s\n\n[aabb1122] 2023-11-14T22:13:20.000Z llm.stream (1.00s)\n    [event] token.generated\n      token: Hello\n      index: 0\n    [event] token.generated\n      token:  world\n      index: 1\n")
}

func TestFormatExcludesInfrastructureAttributes(t *testing.T) {
	spans := mkSpans(spanSpec{id: "aabb112233445566", name: "test", start: at(1700000000, 0), end: at(1700000000, 100_000_000),
		attrs: []attribute.KeyValue{
			attribute.String("langwatch.thread.id", "thread-123"),
			attribute.String("langwatch.scenario.id", "scenario-456"),
			attribute.String("langwatch.scenario.name", "my-scenario"),
			attribute.String("relevant.attribute", "should-appear"),
		}})
	check(t, Format(spans), "Spans: 1 | Total Duration: 100ms\n\n[aabb1122] 2023-11-14T22:13:20.000Z test (100ms)\n    relevant.attribute: should-appear\n")
}

func TestFormatDeduplicates(t *testing.T) {
	long := "This is a long string that exceeds the threshold for deduplication testing purposes."
	two := func(a, b string) []sdktrace.ReadOnlySpan {
		return mkSpans(
			spanSpec{id: "aaaa000000000000", name: "first", start: at(1700000000, 0), end: at(1700000000, 100_000_000), attrs: []attribute.KeyValue{attribute.String("content", a)}},
			spanSpec{id: "bbbb000000000000", name: "second", start: at(1700000000, 200_000_000), end: at(1700000000, 300_000_000), attrs: []attribute.KeyValue{attribute.String("content", b)}},
		)
	}
	out := Format(two(long, long))
	if !strings.Contains(out, long) || !strings.Contains(out, duplicateMarker) || strings.Index(out, long) > strings.Index(out, duplicateMarker) {
		t.Fatalf("expected first occurrence then marker:\n%s", out)
	}
	msg := "This is a long message that should be deduplicated when it appears multiple times."
	input := `{"messages":[{"role":"user","content":"` + msg + `"}]}`
	if out := Format(two(input, input)); strings.Count(out, msg) != 1 || !strings.Contains(out, duplicateMarker) {
		t.Fatalf("expected dedup inside JSON:\n%s", out)
	}
	c1 := "This is a long line one with plenty of content\nLine two has more text\nLine three completes it"
	c2 := "This is a long line one with plenty of content\n\nLine two has more text\n  Line three completes it"
	if out := Format(two(c1, c2)); !strings.Contains(out, duplicateMarker) {
		t.Fatalf("expected whitespace-normalized dedup:\n%s", out)
	}
	if out := Format(two("Short", "Short")); strings.Count(out, "Short") != 2 {
		t.Fatalf("short strings must not dedup:\n%s", out)
	}
	single := mkSpans(spanSpec{id: "aaaa000000000000", name: "test", start: at(1700000000, 0), end: at(1700000000, 100_000_000), attrs: []attribute.KeyValue{attribute.String("content", long)}})
	if a, b := Format(single), Format(single); strings.Contains(a, duplicateMarker) || strings.Contains(b, duplicateMarker) {
		t.Fatal("dedup state must reset between calls")
	}
}

func TestFormatTruncatesMedia(t *testing.T) {
	audio := `{"type":"file","mediaType":"audio/wav","data":"` + strings.Repeat("A", 400) + `"}`
	spans := mkSpans(spanSpec{id: "aaaa000000000000", name: "media", start: at(1700000000, 0), end: at(1700000000, 1_000_000),
		attrs: []attribute.KeyValue{
			attribute.String("img", "data:image/png;base64,"+strings.Repeat("B", 300)),
			attribute.String("part", audio),
		}})
	out := Format(spans)
	for _, want := range []string{"img: [IMAGE: image/png, ~300 bytes]", `part: {"type":"file","mediaType":"audio/wav","data":"[AUDIO: audio/wav, ~400 bytes]"}`} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}
}

func TestFormatStructureOnly(t *testing.T) {
	spans := mkSpans(
		spanSpec{id: "1111000000000000", name: "agent.run", start: at(1700000000, 0), end: at(1700000010, 0)},
		spanSpec{id: "2222000000000000", parent: "1111000000000000", name: "chat claude-opus-4-6", start: at(1700000001, 0), end: at(1700000006, 0),
			attrs: []attribute.KeyValue{attribute.Int("gen_ai.usage.input_tokens", 18000), attribute.Int("gen_ai.usage.output_tokens", 3693), attribute.String("gen_ai.prompt", "secret")}},
		spanSpec{id: "3333000000000000", parent: "1111000000000000", name: "execute_tool exec", start: at(1700000006, 0), end: at(1700000007, 500_000_000)},
	)
	out := FormatStructureOnly(spans)
	for _, want := range []string{"chat claude-opus-4-6 (5.00s, 21693 tokens)", "execute_tool exec (1.50s)", "[22220000]"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}
	if strings.Contains(out, "secret") || strings.Contains(out, "expand_trace") {
		t.Errorf("structure-only leaked content:\n%s", out)
	}
}

func TestToFixedRoundsHalfUp(t *testing.T) {
	// 1125ms → 1.125s exactly: JS toFixed(2) gives 1.13, Go's half-even 1.12.
	check(t, string(appendDuration(nil, 1125)), "1.13s")
	check(t, string(appendDuration(nil, 999.5)), "1000ms")
	check(t, string(appendDuration(nil, 2050)), "2.05s")
}

func TestTraceTools(t *testing.T) {
	spans := mkSpans(
		spanSpec{id: "a0b1c2d3e4f56789", name: "agent.run", start: at(1700000000, 0), end: at(1700000002, 0), attrs: []attribute.KeyValue{attribute.String("agent.type", "rag")}},
		spanSpec{id: "b1c2d3e4f5678901", parent: "a0b1c2d3e4f56789", name: "llm.call", start: at(1700000000, 100_000_000), end: at(1700000000, 500_000_000),
			attrs: []attribute.KeyValue{attribute.String("gen_ai.prompt", "What is the weather in Paris?"), attribute.String("model", "gpt-4")}},
		spanSpec{id: "e4f5678901234567", parent: "a0b1c2d3e4f56789", name: "failed.operation", start: at(1700000001, 600_000_000), end: at(1700000001, 700_000_000), errMsg: "Connection refused"},
	)
	out := ExpandTrace(spans, []string{"b1c2d3e4"})
	if !strings.Contains(out, "[b1c2d3e4]") || !strings.Contains(out, "gen_ai.prompt: What is the weather in Paris?") {
		t.Errorf("expand: %s", out)
	}
	if out := ExpandTrace(spans, []string{"ffffffff"}); !strings.Contains(out, "no spans matched") || !strings.Contains(out, "a0b1c2d3") {
		t.Errorf("expand miss: %s", out)
	}
	if out := ExpandTrace(spans, []string{"e4f56789"}); !strings.Contains(out, "ERROR") {
		t.Errorf("expand error: %s", out)
	}
	if out := GrepTrace(spans, "PARIS"); !strings.Contains(out, "--- [b1c2d3e4] llm.call (400ms) ---") || !strings.Contains(out, "  gen_ai.prompt: What is the weather in Paris?") {
		t.Errorf("grep: %s", out)
	}
	if out := GrepTrace(spans, "nothing-here"); !strings.HasPrefix(out, `No matches found for "nothing-here". Available span names: agent.run, llm.call, failed.operation`) {
		t.Errorf("grep miss: %s", out)
	}
	big := mkSpans(spanSpec{id: "aabb00112233aabb", name: "big.span", start: at(1700000000, 0), end: at(1700000001, 0), attrs: []attribute.KeyValue{attribute.String("massive.content", strings.Repeat("x", 20000))}})
	if out := ExpandTrace(big, []string{"aabb0011"}); len(out) > 17000 || !strings.Contains(out, "[TRUNCATED]") {
		t.Errorf("expected truncation, len %d", len(out))
	}
}

func TestEstimateTokens(t *testing.T) {
	if EstimateTokens("") != 0 || EstimateTokens("abcd") != 1 || EstimateTokens("abcde") != 2 || EstimateTokens("😀") != 1 {
		t.Fatal("estimateTokens must be ceil(utf8 bytes / 4)")
	}
}
