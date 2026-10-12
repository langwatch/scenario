package vad

import "github.com/langwatch/scenario/go/voice/audio"

// Speech gate defaults, measured on a real Twilio call against an
// ElevenLabs callee (100 ms windows, int16 scale): between-utterance noise
// p95 ≈ 740, speech p10 ≈ 940, p50 ≈ 1380.
const (
	// DefaultGateRMSThreshold is the chunk RMS at or above which a chunk is
	// speech.
	DefaultGateRMSThreshold = 800
	// DefaultGateHangoverMs is how long chunks keep being admitted after
	// energy drops, so breaths and commas do not split an utterance.
	DefaultGateHangoverMs = 400
	// DefaultGatePrerollMs is how much of the quiet before an onset is
	// replayed ahead of it, so a soft first syllable is not clipped.
	DefaultGatePrerollMs = 300
)

// GateOptions tune a [SpeechGate]. Zero values select the defaults.
type GateOptions struct {
	RMSThreshold float64
	// HangoverMs overrides [DefaultGateHangoverMs]; a negative value turns
	// the hangover off.
	HangoverMs float64
	// PrerollMs overrides [DefaultGatePrerollMs]; a negative value turns
	// the pre-roll off.
	PrerollMs float64
}

// SpeechGate admits inbound call audio only while the far end is speaking.
//
// A phone line delivers a frame every 20 ms for the whole call, silence
// included, so "the agent stopped talking" can never be detected as a gap in
// chunk arrival. The gate drops silent chunks before they reach the inbound
// queue, so the downstream drain sees a real gap once the callee stops.
// Chunks are admitted while their RMS clears the threshold, for a hangover
// after energy drops, and preceded at each onset by a short pre-roll of the
// quiet chunks just before it.
//
// An empty chunk is the media loop's end-of-call signal: it always passes
// through and resets the per-call state.
//
// Held pre-roll chunks keep referencing their Data, so callers must not
// reuse a chunk's buffer after passing it to Admit. A SpeechGate is not safe
// for concurrent use.
type SpeechGate struct {
	threshold, hangoverMs, prerollMs float64

	speaking bool
	silentMs float64
	preroll  []audio.Chunk
	heldMs   float64

	// DroppedChunks is how many chunks were dropped as silence over the
	// gate's lifetime.
	DroppedChunks int
	// DroppedMs is how many milliseconds of audio were dropped as silence.
	DroppedMs float64
	// Onsets is the number of speech onsets admitted (≈ utterances heard).
	Onsets int
}

// NewSpeechGate returns a gate configured by opts.
func NewSpeechGate(opts GateOptions) *SpeechGate {
	g := &SpeechGate{threshold: opts.RMSThreshold, hangoverMs: opts.HangoverMs, prerollMs: opts.PrerollMs}
	if g.threshold == 0 {
		g.threshold = DefaultGateRMSThreshold
	}
	switch {
	case g.hangoverMs == 0:
		g.hangoverMs = DefaultGateHangoverMs
	case g.hangoverMs < 0:
		g.hangoverMs = 0
	}
	switch {
	case g.prerollMs == 0:
		g.prerollMs = DefaultGatePrerollMs
	case g.prerollMs < 0:
		g.prerollMs = 0
	}
	return g
}

// Speaking reports whether the far end is (or was within the hangover)
// speaking.
func (g *SpeechGate) Speaking() bool { return g.speaking }

// Reset forgets the per-call state (speaking flag, hangover, held pre-roll)
// but keeps the lifetime counters, so a disconnect-time report still sees
// the whole call.
func (g *SpeechGate) Reset() {
	g.speaking = false
	g.silentMs = 0
	clear(g.preroll)
	g.preroll = g.preroll[:0]
	g.heldMs = 0
}

// ResetCounters also zeroes the lifetime counters, for a fresh connection.
func (g *SpeechGate) ResetCounters() {
	g.Reset()
	g.DroppedChunks, g.DroppedMs, g.Onsets = 0, 0, 0
}

// Admit decides what reaches the queue for one incoming chunk and appends
// it to dst: nothing (dropped as silence), the chunk, or at a speech onset
// the held pre-roll followed by the chunk. It allocates only while the
// pre-roll buffer first grows to its working size.
func (g *SpeechGate) Admit(dst []audio.Chunk, c audio.Chunk) []audio.Chunk {
	if len(c.Data) == 0 {
		g.Reset()
		return append(dst, c)
	}
	chunkMs := c.Seconds() * 1000
	speech := audio.RMS(c.Data) >= g.threshold

	if g.speaking {
		if speech {
			g.silentMs = 0
			return append(dst, c)
		}
		g.silentMs += chunkMs
		if g.silentMs <= g.hangoverMs {
			return append(dst, c)
		}
		// Hangover elapsed: the utterance is over, and this chunk starts the
		// next pre-roll window.
		g.speaking = false
		g.silentMs = 0
		g.hold(c, chunkMs)
		return dst
	}
	if !speech {
		g.hold(c, chunkMs)
		return dst
	}

	// Onset: replay the held pre-roll ahead of the first speech chunk. It is
	// delivered after all, so it no longer counts as dropped.
	g.speaking = true
	g.silentMs = 0
	g.Onsets++
	g.DroppedChunks -= len(g.preroll)
	g.DroppedMs -= g.heldMs
	dst = append(dst, g.preroll...)
	clear(g.preroll)
	g.preroll = g.preroll[:0]
	g.heldMs = 0
	return append(dst, c)
}

// hold keeps c in the bounded pre-roll window, counting it as dropped.
func (g *SpeechGate) hold(c audio.Chunk, chunkMs float64) {
	g.DroppedChunks++
	g.DroppedMs += chunkMs
	g.preroll = append(g.preroll, c)
	g.heldMs += chunkMs
	evict := 0
	for g.heldMs > g.prerollMs && evict < len(g.preroll) {
		g.heldMs -= g.preroll[evict].Seconds() * 1000
		evict++
	}
	if evict > 0 {
		n := copy(g.preroll, g.preroll[evict:])
		clear(g.preroll[n:])
		g.preroll = g.preroll[:n]
	}
}
