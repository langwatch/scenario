package spandigest

import (
	"fmt"
	"regexp"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// toolSpans is the span set of the JS trace-tools tests.
func toolSpans() []sdktrace.ReadOnlySpan {
	return mkSpans(
		spanSpec{id: "a0b1c2d3e4f56789", name: "agent.run", start: at(1700000000, 0), end: at(1700000002, 0),
			attrs: []attribute.KeyValue{attribute.String("agent.type", "rag")}},
		spanSpec{id: "b1c2d3e4f5678901", parent: "a0b1c2d3e4f56789", name: "llm.call", start: at(1700000000, 100_000_000), end: at(1700000000, 500_000_000),
			attrs: []attribute.KeyValue{
				attribute.String("gen_ai.prompt", "What is the weather in Paris?"),
				attribute.String("gen_ai.completion", "Let me check the weather for you."),
				attribute.String("model", "gpt-4"),
			}},
		spanSpec{id: "c2d3e4f567890123", parent: "a0b1c2d3e4f56789", name: "tool.fetch_report", start: at(1700000000, 600_000_000), end: at(1700000000, 900_000_000),
			attrs: []attribute.KeyValue{
				attribute.String("tool.name", "fetch_report"),
				attribute.String("tool.input", `{"city": "Paris"}`),
				attribute.String("tool.output", `{"temp": 22, "condition": "sunny"}`),
			}},
		spanSpec{id: "d3e4f56789012345", parent: "a0b1c2d3e4f56789", name: "llm.completion", start: at(1700000001, 0), end: at(1700000001, 500_000_000),
			attrs: []attribute.KeyValue{
				attribute.String("gen_ai.prompt", "Summarize the weather report"),
				attribute.String("gen_ai.completion", "The weather in Paris is sunny with a temperature of 22 degrees."),
			},
			events: []sdktrace.Event{{Name: "token.generated", Attributes: []attribute.KeyValue{attribute.String("token", "The"), attribute.Int("index", 0)}}}},
		spanSpec{id: "e4f5678901234567", parent: "a0b1c2d3e4f56789", name: "failed.operation", start: at(1700000001, 600_000_000), end: at(1700000001, 700_000_000),
			errMsg: "Connection refused", attrs: []attribute.KeyValue{attribute.String("error.type", "NetworkError")}},
	)
}

func numberedSpans(n int, attr func(i int) attribute.KeyValue) []sdktrace.ReadOnlySpan {
	specs := make([]spanSpec, n)
	for i := range specs {
		specs[i] = spanSpec{
			id: fmt.Sprintf("%016x", i), name: fmt.Sprintf("operation-%d", i),
			start: at(1700000000+int64(i), 0), end: at(1700000000+int64(i), 100_000_000),
			attrs: []attribute.KeyValue{attr(i)},
		}
	}
	return mkSpans(specs...)
}

func mustContain(t *testing.T, out string, subs ...string) {
	t.Helper()
	for _, s := range subs {
		if !strings.Contains(out, s) {
			t.Errorf("output lacks %q:\n%s", s, out)
		}
	}
}

func TestExpandTraceCases(t *testing.T) {
	spans := toolSpans()
	mustContain(t, ExpandTrace(spans, []string{"b1c2d3e4"}), "[b1c2d3e4]", "llm.call", "gen_ai.prompt", "What is the weather in Paris?", "gen_ai.completion", "gpt-4")
	mustContain(t, ExpandTrace(spans, []string{"b1c2d3e4", "c2d3e4f5"}), "llm.call", "tool.fetch_report", "gen_ai.prompt", "fetch_report")
	mustContain(t, ExpandTrace(spans, []string{"ffffffff"}), "no spans matched", "a0b1c2d3")
	mustContain(t, ExpandTrace(spans, []string{"d3e4f567"}), "token.generated", "token: The")
	mustContain(t, ExpandTrace(spans, []string{"e4f56789"}), "ERROR", "Connection refused")
	mustContain(t, ExpandTrace(spans, nil), "Error")
	if got := ExpandTrace(nil, []string{"anything"}); got != "No spans recorded." {
		t.Errorf("empty: %q", got)
	}
	prefixed := mkSpans(
		spanSpec{id: "aa11bb22cc33dd44", name: "first.op", start: at(1700000000, 0), end: at(1700000000, 100_000_000)},
		spanSpec{id: "aa11bb22dd44ee55", name: "second.op", start: at(1700000000, 200_000_000), end: at(1700000000, 300_000_000)},
	)
	mustContain(t, ExpandTrace(prefixed, []string{"aa11bb22"}), "first.op", "second.op")
	big := mkSpans(spanSpec{id: "aabb00112233aabb", name: "big.span", start: at(1700000000, 0), end: at(1700000001, 0),
		attrs: []attribute.KeyValue{attribute.String("massive.content", strings.Repeat("x", 20000))}})
	if out := ExpandTrace(big, []string{"aabb0011"}); len(out) > 17000 || !strings.Contains(out, "[TRUNCATED]") {
		t.Errorf("expected truncation, len %d", len(out))
	}
}

func TestGrepTraceCases(t *testing.T) {
	spans := toolSpans()
	mustContain(t, GrepTrace(spans, "fetch_report"), "fetch_report", "[c2d3e4f5]", "tool.fetch_report")
	mustContain(t, GrepTrace(spans, "weather"), "llm.call", "llm.completion")
	mustContain(t, GrepTrace(spans, "FETCH_REPORT"), "fetch_report")
	mustContain(t, GrepTrace(spans, "nonexistent_xyz_pattern"), "No matches found", "agent.run")
	mustContain(t, GrepTrace(spans, "token.generated"), "llm.completion", "token.generated")
	// Regex metacharacters are literal.
	mustContain(t, GrepTrace(spans, `{"city"`), "tool.fetch_report")
	if out := GrepTrace(spans, "c.ty"); !strings.HasPrefix(out, "No matches found") {
		t.Errorf("pattern must be literal: %s", out)
	}

	many := numberedSpans(30, func(int) attribute.KeyValue { return attribute.String("common.attr", "matching_value") })
	out := GrepTrace(many, "matching_value")
	if n := len(regexp.MustCompile(`\[[0-9a-f]{8}\]`).FindAllString(out, -1)); n > 20 {
		t.Errorf("%d matches shown", n)
	}
	mustContain(t, out, "more match")

	big := numberedSpans(10, func(int) attribute.KeyValue {
		return attribute.String("big.content", "match_"+strings.Repeat("x", 3000))
	})
	if out := GrepTrace(big, "match_"); len(out) > 17000 {
		t.Errorf("grep output not truncated: %d", len(out))
	}
}

func TestGrepTraceUnicodeCaseFolding(t *testing.T) {
	spans := mkSpans(spanSpec{id: "a0b1c2d3e4f56789", name: "café.lookup", start: at(1700000000, 0), end: at(1700000001, 0),
		attrs: []attribute.KeyValue{attribute.String("note", "ÉTÉ À PARIS")}})
	mustContain(t, GrepTrace(spans, "été à"), "note: ÉTÉ À PARIS")
	mustContain(t, GrepTrace(spans, "CAFÉ"), "café.lookup")
}

func TestEstimateTokensCases(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"", 0},
		{strings.Repeat("a", 4000), 1000},
		{"abcdefgh", 2},
		{"abcde", 2},
	}
	for _, c := range cases {
		if got := EstimateTokens(c.in); got != c.want {
			t.Errorf("EstimateTokens(%d bytes) = %d, want %d", len(c.in), got, c.want)
		}
	}
	if emoji := "😀😀😀😀"; EstimateTokens(emoji) <= 1 {
		t.Error("emoji must count more tokens than characters / 4")
	}
	if EstimateTokens("你好世界") <= EstimateTokens("abcd") {
		t.Error("CJK must count more tokens than ASCII of the same length")
	}
}

func toolBenchSpans() []sdktrace.ReadOnlySpan {
	return numberedSpans(200, func(i int) attribute.KeyValue {
		return attribute.String("langwatch.output", fmt.Sprintf(`{"rows":[{"id":%d,"city":"Paris","note":"%s"}]}`, i, strings.Repeat("lorem ipsum ", 20)))
	})
}

func BenchmarkGrepTrace(b *testing.B) {
	spans := toolBenchSpans()
	b.ReportAllocs()
	for b.Loop() {
		GrepTrace(spans, "PARIS")
	}
}

func BenchmarkExpandTrace(b *testing.B) {
	spans := toolBenchSpans()
	ids := []string{"0000000000000001", "000000000000000a"}
	b.ReportAllocs()
	for b.Loop() {
		ExpandTrace(spans, ids)
	}
}

func BenchmarkEstimateTokens(b *testing.B) {
	text := Format(toolBenchSpans())
	b.ReportAllocs()
	for b.Loop() {
		EstimateTokens(text)
	}
}

func BenchmarkFormatStructureOnly(b *testing.B) {
	spans := toolBenchSpans()
	b.ReportAllocs()
	for b.Loop() {
		FormatStructureOnly(spans)
	}
}
