package twilio

import (
	"math"
	"slices"
)

func sin(x float64) float64 { return math.Sin(x) }

func abs(x float64) float64 { return math.Abs(x) }

// jsRound is JavaScript's Math.round (halves toward +∞).
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

func sortStrings(s []string) { slices.Sort(s) }
