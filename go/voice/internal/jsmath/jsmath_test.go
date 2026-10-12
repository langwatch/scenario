package jsmath

import (
	"math"
	"testing"
)

func TestRoundMatchesJavaScript(t *testing.T) {
	cases := map[float64]float64{
		2.5: 3, -2.5: -2, 0.49999999999999994: 0, -0.5: 0, 1.4: 1, -1.6: -2, 0: 0,
	}
	for in, want := range cases {
		if got := Round(in); got != want {
			t.Errorf("Round(%v) = %v, want %v", in, got, want)
		}
	}
}

func TestInt16ClampsAndZeroesNaN(t *testing.T) {
	if got := Int16(40000); got != math.MaxInt16 {
		t.Errorf("Int16(40000) = %d", got)
	}
	if got := Int16(-40000); got != math.MinInt16 {
		t.Errorf("Int16(-40000) = %d", got)
	}
	if got := Int16(math.NaN()); got != 0 {
		t.Errorf("Int16(NaN) = %d", got)
	}
	if got := Int16(-32768.4); got != -32768 {
		t.Errorf("Int16(-32768.4) = %d", got)
	}
}
