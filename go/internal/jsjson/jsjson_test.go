package jsjson

import (
	"math"
	"testing"
)

func TestNumbersFormatLikeJavaScript(t *testing.T) {
	cases := map[float64]string{
		0: "0", 1: "1", -1: "-1", 1.5: "1.5", 0.1: "0.1", 100: "100", 1e21: "1e+21", 1.5e-7: "1.5e-7",
		0.000001: "0.000001", 123456789012: "123456789012", 1e300: "1e+300", math.NaN(): "null", -0.5: "-0.5",
	}
	for in, want := range cases {
		if got := string(AppendNumber(nil, in)); got != want {
			t.Errorf("%v: got %s want %s", in, got, want)
		}
	}
}

func TestParseKeepsKeyOrderAndStringifiesCompactly(t *testing.T) {
	in := `{ "b": 1, "a": [true, null, "xé\n"], "b": 2.50, "c": {"z": {}, "y": []} }`
	if got, want := Compact(in), `{"b":2.5,"a":[true,null,"xé\n"],"c":{"z":{},"y":[]}}`; got != want {
		t.Fatalf("got %s want %s", got, want)
	}
	if Compact("not json") != "not json" {
		t.Fatal("invalid JSON must pass through")
	}
}

func TestStringEscaping(t *testing.T) {
	if got, want := Stringify("<a>&\"\\\t\x01"), `"<a>&\"\\\t\u0001"`; got != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

func TestLooksLikeJSON(t *testing.T) {
	for s, want := range map[string]bool{` {"a":1} `: true, "[1]": true, "{": false, "x": false, "[}": false} {
		if LooksLikeJSON(s) != want {
			t.Errorf("%q", s)
		}
	}
}
