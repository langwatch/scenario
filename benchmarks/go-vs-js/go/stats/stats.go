// Package stats summarizes repeated measurements the same way the JS side
// of the benchmark does (../../js/lib/stats.mjs).
package stats

import (
	"encoding/json"
	"math"
	"os"
	"runtime"
	"slices"
	"syscall"
)

// Summary of a sample of durations or sizes.
type Summary struct {
	N      int     `json:"n"`
	Median float64 `json:"median"`
	P95    float64 `json:"p95"`
	Mean   float64 `json:"mean"`
	Min    float64 `json:"min"`
	Max    float64 `json:"max"`
}

// Summarize returns the median, nearest-rank p95, mean, min and max.
func Summarize(xs []float64) Summary {
	if len(xs) == 0 {
		return Summary{}
	}
	s := slices.Clone(xs)
	slices.Sort(s)
	sum := 0.0
	for _, x := range s {
		sum += x
	}
	return Summary{
		N:      len(s),
		Median: Quantile(s, 0.5),
		P95:    Quantile(s, 0.95),
		Mean:   sum / float64(len(s)),
		Min:    s[0],
		Max:    s[len(s)-1],
	}
}

// Quantile is the nearest-rank quantile of sorted xs.
func Quantile(sorted []float64, q float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	i := int(math.Ceil(q*float64(len(sorted)))) - 1
	return sorted[max(0, min(i, len(sorted)-1))]
}

// MaxRSSBytes is the peak resident set size of this process so far.
func MaxRSSBytes() int64 {
	var ru syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err != nil {
		return 0
	}
	if runtime.GOOS == "darwin" {
		return int64(ru.Maxrss) // bytes on macOS
	}
	return int64(ru.Maxrss) * 1024 // kilobytes on Linux
}

// WriteJSON writes v as indented JSON to path, or stdout when path is "".
func WriteJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	if path == "" {
		_, err = os.Stdout.Write(b)
		return err
	}
	return os.WriteFile(path, b, 0o644)
}
