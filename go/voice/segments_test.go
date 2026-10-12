package voice

import "testing"

func TestInterruptResponseTime(t *testing.T) {
	timeline := []VoiceEvent{
		{Type: UserInterrupt, Time: 1.0},
		{Type: AgentStopSpeaking, Time: 1.4},
		{Type: UserInterrupt, Time: 3.0},
		{Type: UserStartSpeaking, Time: 3.05},
		{Type: AgentStopSpeaking, Time: 3.1},
	}
	got, ok := InterruptResponseTime(timeline)
	if !ok || got < 0.0999 || got > 0.1001 {
		t.Errorf("got %v, %v; want 0.1", got, ok)
	}
	if _, ok := InterruptResponseTime([]VoiceEvent{{Type: UserInterrupt, Time: 1}}); ok {
		t.Error("interrupt without a following stop measured")
	}
}

func TestMarkTruncatedAgentSegmentsIsInclusive(t *testing.T) {
	segs := []AudioSegment{
		{Speaker: SpeakerAgent, StartTime: 0, EndTime: 1},  // interrupt on end bound
		{Speaker: SpeakerAgent, StartTime: 2, EndTime: 3},  // interrupt on start bound
		{Speaker: SpeakerAgent, StartTime: 4, EndTime: 5},  // untouched
		{Speaker: SpeakerUser, StartTime: 0.5, EndTime: 2}, // users are never marked
	}
	MarkTruncatedAgentSegments(segs, []VoiceEvent{{Type: UserInterrupt, Time: 1}, {Type: UserInterrupt, Time: 2}})
	want := []bool{true, true, false, false}
	for i, w := range want {
		if segs[i].TranscriptTruncated != w {
			t.Errorf("segment %d truncated = %v", i, segs[i].TranscriptTruncated)
		}
	}
}
