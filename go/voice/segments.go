package voice

// Post-processing over recorded segments and the timeline. Interrupt events
// and segments share the byte-accurate audio cursor, so comparing their
// times is like for like.

// InterruptResponseTime is the shortest gap between a user_interrupt and the
// next agent_stop_speaking: how fast the agent stopped once the user barged
// in. ok is false when no interrupt is followed by an agent stop.
func InterruptResponseTime(timeline []VoiceEvent) (seconds float64, ok bool) {
	for i, e := range timeline {
		if e.Type != UserInterrupt {
			continue
		}
		for _, next := range timeline[i+1:] {
			if next.Type != AgentStopSpeaking {
				continue
			}
			if dt := next.Time - e.Time; dt >= 0 && (!ok || dt < seconds) {
				seconds, ok = dt, true
			}
			break
		}
	}
	return seconds, ok
}

// MarkTruncatedAgentSegments sets TranscriptTruncated on every agent
// segment whose [StartTime, EndTime] contains a user_interrupt. Both bounds
// are inclusive: the interrupt cursor lands exactly on the truncated
// segment's start (slow transport) or end (fast transport).
func MarkTruncatedAgentSegments(segments []AudioSegment, timeline []VoiceEvent) {
	for i := range segments {
		seg := &segments[i]
		if seg.Speaker != SpeakerAgent {
			continue
		}
		for _, e := range timeline {
			if e.Type == UserInterrupt && seg.StartTime <= e.Time && e.Time <= seg.EndTime {
				seg.TranscriptTruncated = true
				break
			}
		}
	}
}
