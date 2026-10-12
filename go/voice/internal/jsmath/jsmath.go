// Package jsmath reproduces the JavaScript numeric conversions the voice
// subsystem's reference implementation relies on, so Go output matches the
// JavaScript SDK sample for sample.
package jsmath

import "math"

// Round is JavaScript's Math.round: the nearest integer, ties toward +Inf.
//
// It differs from math.Round (ties away from zero) on negative halves:
// Round(-2.5) is -2, not -3. It is computed from math.Floor rather than as
// Floor(x+0.5), which misrounds 0.49999999999999994.
func Round(x float64) float64 {
	f := math.Floor(x)
	if x-f >= 0.5 {
		return f + 1
	}
	return f
}

// Int16 rounds x with [Round], clamps it to the int16 range and returns it,
// the way JavaScript stores Math.max(-32768, Math.min(32767, Math.round(x)))
// into an Int16Array. NaN becomes 0, as it does there.
func Int16(x float64) int16 {
	if x != x {
		return 0
	}
	r := Round(x)
	if r > math.MaxInt16 {
		return math.MaxInt16
	}
	if r < math.MinInt16 {
		return math.MinInt16
	}
	return int16(r)
}

// Float32 rounds x to single precision and widens it back, the way a value
// stored into a JavaScript Float32Array reads back.
func Float32(x float64) float64 {
	return float64(float32(x))
}
