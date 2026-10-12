package voice

import (
	"math"
	"slices"
)

// ComputeLatencyMetrics aggregates per-turn response times: average, p50
// and p95 (a ceiling index, so the tail shows). The aggregates stay nil
// without measurements.
func ComputeLatencyMetrics(measurements []float64, timeToFirstByte, interruptResponseTime *float64) LatencyMetrics {
	m := LatencyMetrics{
		Measurements:          slices.Clone(measurements),
		TimeToFirstByte:       timeToFirstByte,
		InterruptResponseTime: interruptResponseTime,
	}
	if m.Measurements == nil {
		m.Measurements = []float64{}
	}
	n := len(measurements)
	if n == 0 {
		return m
	}
	sorted := slices.Clone(measurements)
	slices.Sort(sorted)
	sum := 0.0
	for _, v := range measurements {
		sum += v
	}
	avg := sum / float64(n)
	p50 := sorted[(n-1)/2]
	p95 := sorted[min(n-1, int(math.Ceil(0.95*float64(n-1))))]
	m.AvgResponseTime, m.P50ResponseTime, m.P95ResponseTime = &avg, &p50, &p95
	return m
}
