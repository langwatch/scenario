package spandigest

import (
	"strings"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/langwatch/scenario/go/internal/jsjson"
)

// trickyValues exercise every branch of the value transform: long and
// repeated text, nested JSON documents, media, escaping and invalid UTF-8.
func trickyValues() []string {
	long := strings.Repeat("The quick brown fox jumps over the lazy dog. ", 3)
	nested := jsjson.Stringify(jsjson.Object{{Key: "text", Value: long}, {Key: "q", Value: "say \"hi\"\n\ttab"}})
	doubly := jsjson.Stringify(jsjson.Object{{Key: "inner", Value: nested}, {Key: "again", Value: long}})
	img := "data:image/png;base64," + strings.Repeat("iVBORw0KGgo", 20)
	return []string{
		"short",
		long,
		"  " + strings.ToUpper(long) + "\n",
		strings.ReplaceAll(long, " ", `\n`),
		`{"type":"chat_messages","value":[{"role":"user","content":"` + long + `"}]}`,
		`[` + jsjson.Stringify(long) + `,` + jsjson.Stringify(nested) + `,` + jsjson.Stringify(doubly) + `]`,
		doubly,
		`{"broken": "json"`,
		`[not json]`,
		img,
		`{"parts":[{"type":"image","image":` + jsjson.Stringify(img) + `},{"type":"file","mediaType":"audio/wav","data":"` + strings.Repeat("A", 80) + `","note":` + jsjson.Stringify(long) + `}]}`,
		`{"url":` + jsjson.Stringify(img) + `,"x":1.5e300,"y":null,"z":true}`,
		"ünïcödé ünïcödé ünïcödé ünïcödé ünïcödé ünïcödé", // >= 50 bytes, < 50 UTF-16 units
		strings.Repeat("ü", 60),
		"invalid \xff\xfe utf8 " + long,
		`{"bad":"` + "\xff" + long + `","ctl":"\u0001\u001f"}`,
		"  line separators   " + long,
	}
}

func trickySpans() []sdktrace.ReadOnlySpan {
	vals := trickyValues()
	var specs []spanSpec
	ids := []string{"a000000000000001", "a000000000000002", "a000000000000003", "a000000000000004", "a000000000000005", "a000000000000006"}
	parents := []string{"", "a000000000000001", "a000000000000002", "a000000000000002", "a000000000000004", ""}
	for i, id := range ids {
		var attrs []attribute.KeyValue
		for j, v := range vals {
			if (i+j)%2 == 0 {
				attrs = append(attrs, attribute.String("langwatch.attr"+string(rune('a'+j)), v))
			}
		}
		attrs = append(attrs,
			attribute.StringSlice("list", []string{vals[1], vals[4], "x"}),
			attribute.Int64Slice("ints", []int64{1, 2}),
			attribute.Float64("f", 0.1),
			attribute.Bool("b", true),
			attribute.String("langwatch.thread.id", "t"),
		)
		spec := spanSpec{
			id: id, parent: parents[i], name: "span-" + id[len(id)-1:],
			start: at(1700000000+int64(i), 0), end: at(1700000000+int64(i), 250_000_000),
			attrs: attrs,
			events: []sdktrace.Event{{Name: "ev", Attributes: []attribute.KeyValue{
				attribute.String("payload", vals[i%len(vals)]), attribute.String("again", vals[1]),
			}}},
		}
		if i == 3 {
			spec.errMsg = "boom"
		}
		specs = append(specs, spec)
	}
	return mkSpans(specs...)
}

func TestCompiledDigestMatchesReference(t *testing.T) {
	spans := trickySpans()
	want := referenceFormat(spans)
	check(t, Format(spans), want)
	// A cache reused across a growing trace renders every prefix the same,
	// including spans compiled for an earlier, shorter digest.
	cache := NewCache()
	for n := 1; n <= len(spans); n++ {
		check(t, cache.Format(spans[:n]), referenceFormat(spans[:n]))
	}
	// Spans compiled in one order and rendered in another dedupe by the
	// render order.
	reversed := make([]sdktrace.ReadOnlySpan, len(spans))
	for i, s := range spans {
		reversed[len(spans)-1-i] = s
	}
	check(t, cache.Format(reversed[:3]), referenceFormat(reversed[:3]))
	check(t, cache.Format(spans), want)
}

func TestFormatValueMatchesReference(t *testing.T) {
	vals := trickyValues()
	attrs := []attribute.Value{attribute.StringSliceValue(vals), attribute.Int64SliceValue([]int64{1, -2}), attribute.Float64Value(0.25), attribute.BoolValue(false)}
	for _, v := range vals {
		attrs = append(attrs, attribute.StringValue(v))
	}
	for _, v := range attrs {
		check(t, FormatValue(v), referenceFormatValue(v))
	}
}

func FuzzCompiledDigestMatchesReference(f *testing.F) {
	for _, v := range trickyValues() {
		f.Add(v)
	}
	f.Fuzz(func(t *testing.T, v string) {
		nested := jsjson.Stringify(jsjson.Object{{Key: "v", Value: v}, {Key: "w", Value: []any{v}}})
		spans := mkSpans(
			spanSpec{id: "b000000000000001", name: "root", start: at(1, 0), end: at(2, 0),
				attrs: []attribute.KeyValue{attribute.String("a", v), attribute.String("n", nested), attribute.StringSlice("s", []string{v})}},
			spanSpec{id: "b000000000000002", parent: "b000000000000001", name: "child", start: at(1, 5), end: at(1, 9),
				attrs: []attribute.KeyValue{attribute.String("a", v), attribute.String("n", jsjson.Stringify([]any{nested, v}))}},
		)
		if got, want := FormatValue(attribute.StringValue(v)), referenceFormatValue(attribute.StringValue(v)); got != want {
			t.Fatalf("value mismatch for %q\n--- got\n%s\n--- want\n%s", v, got, want)
		}
		if got, want := Format(spans), referenceFormat(spans); got != want {
			t.Fatalf("digest mismatch for %q\n--- got\n%s\n--- want\n%s", v, got, want)
		}
	})
}

func BenchmarkCachedDigestFormat50(b *testing.B) {
	spans := benchSpans(50)
	cache := NewCache()
	b.ReportAllocs()
	for b.Loop() {
		_ = cache.Format(spans)
	}
}
