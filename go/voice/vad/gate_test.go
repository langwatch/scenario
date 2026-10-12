package vad

import (
	"math"
	"testing"

	"github.com/langwatch/scenario/go/voice/audio"
)

// Ported from javascript/src/voice/adapters/__tests__/twilio-speech-gate.test.ts.

// tone is ms of alternating ±amplitude, so its RMS is amplitude.
func tone(ms int, amplitude int16) audio.Chunk {
	n := int(math.Round(float64(audio.SampleRate*ms) / 1000))
	var data []byte
	for i := range n {
		s := amplitude
		if i%2 == 1 {
			s = -amplitude
		}
		data = audio.AppendSample(data, s)
	}
	return audio.Chunk{Data: data}
}

const (
	speech = 1380
	noise  = 740
)

func admitted(g *SpeechGate, c audio.Chunk) int { return len(g.Admit(nil, c)) }

func TestGateDropsContinuousLineNoise(t *testing.T) {
	g := NewSpeechGate(GateOptions{})
	for range 50 {
		if n := admitted(g, tone(100, noise)); n != 0 {
			t.Fatalf("admitted %d noise chunks", n)
		}
	}
	if g.Speaking() || g.DroppedChunks != 50 || math.Abs(g.DroppedMs-5000) > 0.5 {
		t.Errorf("speaking %v dropped %d / %vms", g.Speaking(), g.DroppedChunks, g.DroppedMs)
	}
}

func TestGateReplaysPrerollAndKeepsHangover(t *testing.T) {
	g := NewSpeechGate(GateOptions{HangoverMs: 400, PrerollMs: 200})
	for range 10 {
		admitted(g, tone(100, noise))
	}
	if n := admitted(g, tone(100, speech)); n != 3 {
		t.Fatalf("onset admitted %d chunks, want 2 pre-roll + 1", n)
	}
	if !g.Speaking() || g.Onsets != 1 || g.DroppedChunks != 8 {
		t.Errorf("speaking %v onsets %d dropped %d", g.Speaking(), g.Onsets, g.DroppedChunks)
	}
	for _, amp := range []int16{noise, noise, speech} {
		if n := admitted(g, tone(100, amp)); n != 1 {
			t.Fatalf("mid-sentence chunk admitted %d", n)
		}
	}
	for range 4 {
		if n := admitted(g, tone(100, noise)); n != 1 {
			t.Fatalf("hangover chunk admitted %d", n)
		}
	}
	if n := admitted(g, tone(100, noise)); n != 0 || g.Speaking() {
		t.Errorf("after hangover admitted %d, speaking %v", n, g.Speaking())
	}
}

func TestGateDefaultThreshold(t *testing.T) {
	g := NewSpeechGate(GateOptions{})
	if admitted(g, tone(100, DefaultGateRMSThreshold-1)) != 0 {
		t.Error("below-threshold chunk admitted")
	}
	if admitted(g, tone(100, DefaultGateRMSThreshold+1)) == 0 {
		t.Error("above-threshold chunk dropped")
	}
}

func TestGatePassesTerminalSentinelAndResets(t *testing.T) {
	g := NewSpeechGate(GateOptions{})
	admitted(g, tone(100, speech))
	out := g.Admit(nil, audio.Chunk{})
	if len(out) != 1 || len(out[0].Data) != 0 || g.Speaking() {
		t.Errorf("sentinel gave %v, speaking %v", out, g.Speaking())
	}
}

func TestGateResetForgetsPreroll(t *testing.T) {
	g := NewSpeechGate(GateOptions{PrerollMs: 500})
	for range 5 {
		admitted(g, tone(100, noise))
	}
	g.Reset()
	if n := admitted(g, tone(100, speech)); n != 1 {
		t.Errorf("onset after reset admitted %d", n)
	}
}

func TestGateResetCounters(t *testing.T) {
	g := NewSpeechGate(GateOptions{})
	for range 5 {
		admitted(g, tone(100, noise))
	}
	admitted(g, tone(100, speech))
	g.Reset()
	if g.Onsets != 1 || g.DroppedChunks == 0 {
		t.Errorf("Reset cleared counters: onsets %d dropped %d", g.Onsets, g.DroppedChunks)
	}
	g.ResetCounters()
	if g.Onsets != 0 || g.DroppedChunks != 0 || g.DroppedMs != 0 {
		t.Error("ResetCounters left counters set")
	}
}

func BenchmarkGateFrame(b *testing.B) {
	g := NewSpeechGate(GateOptions{})
	quiet, voiced := tone(20, noise), tone(20, speech)
	dst := make([]audio.Chunk, 0, 32)
	b.ReportAllocs()
	i := 0
	for b.Loop() {
		c := quiet
		if i%50 < 20 {
			c = voiced
		}
		dst = g.Admit(dst[:0], c)
		i++
	}
}

func TestGateNegativeHangoverAndPrerollTurnThemOff(t *testing.T) {
	g := NewSpeechGate(GateOptions{HangoverMs: -1, PrerollMs: -1})
	for range 5 {
		admitted(g, tone(100, noise))
	}
	if n := admitted(g, tone(100, speech)); n != 1 {
		t.Fatalf("onset admitted %d chunks, want no pre-roll", n)
	}
	if n := admitted(g, tone(100, noise)); n != 0 || g.Speaking() {
		t.Fatalf("quiet after speech admitted %d, speaking %v: want no hangover", n, g.Speaking())
	}
}
