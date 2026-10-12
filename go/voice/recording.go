package voice

// Speaker identifies who produced a stretch of audio.
type Speaker string

// Speakers.
const (
	SpeakerUser  Speaker = "user"
	SpeakerAgent Speaker = "agent"
)

// AudioSegment is a contiguous span of audio from one speaker. Times are
// seconds on the byte-accurate audio cursor from scenario start.
type AudioSegment struct {
	Speaker   Speaker
	StartTime float64
	EndTime   float64
	// Audio is canonical PCM16 (24 kHz mono).
	Audio []byte
	// Transcript is what was said; empty when unknown.
	Transcript string
	// TranscriptTruncated is set on agent segments cut short by a user
	// interrupt: the audio is authoritative, while the transcript may hold
	// what the agent intended to say rather than what the user heard.
	TranscriptTruncated bool
}

// VoiceEventType names a timeline event.
type VoiceEventType string

// Timeline event types.
const (
	UserStartSpeaking  VoiceEventType = "user_start_speaking"
	UserStopSpeaking   VoiceEventType = "user_stop_speaking"
	AgentStartSpeaking VoiceEventType = "agent_start_speaking"
	AgentStopSpeaking  VoiceEventType = "agent_stop_speaking"
	UserInterrupt      VoiceEventType = "user_interrupt"
)

// VoiceEvent is one timestamped event on the conversation timeline.
type VoiceEvent struct {
	Type VoiceEventType
	// Time is the audio cursor position, in seconds, when the event fired.
	Time float64
	// Latency is the response time in seconds since the preceding user stop.
	// Only agent_start_speaking events carry it, and only when measurable.
	Latency *float64
	// Metadata is free-form, type-specific context, for example
	// {"source": "vad-fallback"} on fallback-detected user speech.
	Metadata map[string]any
}

// LatencyMetrics summarises agent response timing, in seconds. Nil fields
// were not measurable.
type LatencyMetrics struct {
	Measurements          []float64
	TimeToFirstByte       *float64
	InterruptResponseTime *float64
	AvgResponseTime       *float64
	P50ResponseTime       *float64
	P95ResponseTime       *float64
}

// VoiceRecording is the full audio record of a voice scenario.
type VoiceRecording struct {
	Segments []AudioSegment
	Timeline []VoiceEvent
	// Duration is the largest segment end time, in seconds.
	Duration float64
}
