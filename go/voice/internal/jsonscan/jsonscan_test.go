package jsonscan

import (
	"strings"
	"testing"
)

func TestFieldsWalksMembersAndNestedValues(t *testing.T) {
	obj := []byte(` { "type" : "a\"b", "n": -1.5e3, "o": {"x": [1, {"y": "}"}]}, "t": true, "z": null } `)
	var keys, vals []string
	if !Fields(obj, func(k, v []byte) bool {
		keys = append(keys, string(k))
		vals = append(vals, string(v))
		return true
	}) {
		t.Fatal("walk failed")
	}
	if got := strings.Join(keys, ","); got != "type,n,o,t,z" {
		t.Fatalf("keys = %s", got)
	}
	want := []string{`"a\"b"`, `-1.5e3`, `{"x": [1, {"y": "}"}]}`, `true`, `null`}
	for i, w := range want {
		if vals[i] != w {
			t.Fatalf("value %d = %q, want %q", i, vals[i], w)
		}
	}
	s, esc, ok := String([]byte(vals[0]))
	if !ok || !esc || string(s) != `a\"b` {
		t.Fatalf("String = %q %v %v", s, esc, ok)
	}
	if !IsTrue([]byte(vals[3])) || !IsNull([]byte(vals[4])) {
		t.Fatal("literals")
	}
}

func TestElements(t *testing.T) {
	var n int
	if !Elements([]byte(`[ {"a":1}, "x\\", 3 ]`), func([]byte) bool { n++; return true }) || n != 3 {
		t.Fatalf("elements = %d", n)
	}
	if !Elements([]byte(`[]`), func([]byte) bool { t.Fatal("called"); return true }) {
		t.Fatal("empty array")
	}
}

func TestRejectsMalformed(t *testing.T) {
	for _, in := range []string{``, `[]`, `{"a"}`, `{"a":}`, `{"a":"x`, `{"a":1 "b":2}`, `not json`} {
		if Fields([]byte(in), func(_, _ []byte) bool { return true }) {
			t.Errorf("accepted %q", in)
		}
	}
}

func TestFieldDoesNotAllocate(t *testing.T) {
	frame := []byte(`{"type":"response.output_audio.delta","event_id":"e1","delta":"` + strings.Repeat("QUJD", 2000) + `"}`)
	allocs := testing.AllocsPerRun(100, func() {
		if _, ok := Field(frame, "delta"); !ok {
			t.Fatal("missing")
		}
	})
	if allocs != 0 {
		t.Fatalf("allocs = %v", allocs)
	}
}
