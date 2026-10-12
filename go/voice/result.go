package voice

import scenario "github.com/langwatch/scenario/go"

// Result is the voice part of a scenario result: the recording (with
// Save/SaveSegments), its timeline and the latency metrics.
type Result struct {
	Recording *VoiceRecording
	Timeline  []VoiceEvent
	Latency   *LatencyMetrics
}

// ResultOf returns the voice result of a run, or nil for a text-only run.
func ResultOf(r *scenario.ScenarioResult) *Result {
	if r == nil {
		return nil
	}
	v, _ := r.Extensions[ExtensionKey].(*Result)
	return v
}
