package stats

import "testing"

func TestSummarize(t *testing.T) {
	xs := make([]float64, 0, 100)
	for i := 100; i >= 1; i-- {
		xs = append(xs, float64(i))
	}
	s := Summarize(xs)
	if s.N != 100 || s.Median != 50 || s.P95 != 95 || s.Min != 1 || s.Max != 100 || s.Mean != 50.5 {
		t.Fatalf("%+v", s)
	}
	if xs[0] != 100 {
		t.Fatal("Summarize sorted its input in place")
	}
	if (Summarize(nil) != Summary{}) {
		t.Fatal("empty sample")
	}
}
