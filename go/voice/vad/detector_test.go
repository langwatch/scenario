package vad

import (
	"strings"
	"testing"

	"github.com/langwatch/scenario/go/voice/audio"
)

// Ported from javascript/src/voice/__tests__/vad-framing.test.ts and the
// warning scenarios of vad-fallback.test.ts.

const samplesPerFrame = FrameBytes / 2

const (
	loud   = 8000
	silent = 0
)

func pcm16(amplitude int16, samples int) []byte {
	out := make([]byte, 0, 2*samples)
	for range samples {
		out = audio.AppendSample(out, amplitude)
	}
	return out
}

type probe struct {
	d            *Detector
	starts, ends int
}

func newProbe(hysteresis int) *probe {
	p := &probe{}
	p.d = NewDetector(Options{
		HysteresisFrames: hysteresis,
		OnSpeechStart:    func() { p.starts++ },
		OnSpeechEnd:      func() { p.ends++ },
	})
	return p
}

func TestPartialFrameIsNotClassified(t *testing.T) {
	p := newProbe(1)
	p.d.Process(pcm16(loud, samplesPerFrame-1))
	if p.d.Speaking() || p.starts != 0 {
		t.Error("a partial frame was classified")
	}
}

func TestFrameSplitAcrossChunksClassifiesOnce(t *testing.T) {
	p := newProbe(1)
	frame := pcm16(loud, samplesPerFrame)
	p.d.Process(frame[:10])
	if p.d.Speaking() {
		t.Fatal("classified before the frame was complete")
	}
	p.d.Process(frame[10:])
	if !p.d.Speaking() || p.starts != 1 {
		t.Errorf("speaking %v starts %d", p.d.Speaking(), p.starts)
	}
}

func TestSeveralFramesInOneChunkSatisfyHysteresis(t *testing.T) {
	p := newProbe(3)
	p.d.Process(pcm16(loud, 3*samplesPerFrame))
	if !p.d.Speaking() || p.starts != 1 {
		t.Errorf("speaking %v starts %d", p.d.Speaking(), p.starts)
	}
}

func TestLeftoverBytesCarryAcrossCalls(t *testing.T) {
	p := newProbe(2)
	p.d.Process(pcm16(loud, samplesPerFrame+samplesPerFrame/2))
	if p.d.Speaking() {
		t.Fatal("speaking after one frame with hysteresis 2")
	}
	p.d.Process(pcm16(loud, samplesPerFrame/2))
	if !p.d.Speaking() || p.starts != 1 {
		t.Errorf("speaking %v starts %d", p.d.Speaking(), p.starts)
	}
}

func TestTwoLoudFramesStaySilentUnderHysteresisThree(t *testing.T) {
	p := newProbe(3)
	p.d.Process(pcm16(loud, 2*samplesPerFrame))
	if p.d.Speaking() || p.starts != 0 {
		t.Error("flipped before hysteresis held")
	}
}

func TestSpeechThenSilenceFiresEndOnce(t *testing.T) {
	p := newProbe(3)
	p.d.Process(pcm16(loud, 3*samplesPerFrame))
	p.d.Process(pcm16(silent, 3*samplesPerFrame))
	if p.d.Speaking() || p.starts != 1 || p.ends != 1 {
		t.Errorf("speaking %v starts %d ends %d", p.d.Speaking(), p.starts, p.ends)
	}
}

func TestSignedSamplesAreReadSigned(t *testing.T) {
	quiet := newProbe(1)
	quiet.d.Process(pcm16(-1, samplesPerFrame))
	if quiet.d.Speaking() {
		t.Error("-1 read as loud: the sign was lost")
	}
	neg := newProbe(1)
	neg.d.Process(pcm16(-8000, samplesPerFrame))
	if !neg.d.Speaking() {
		t.Error("-8000 read as silence")
	}
}

func TestConsumedBytesAreNotReclassified(t *testing.T) {
	p := newProbe(1)
	p.d.Process(pcm16(loud, samplesPerFrame))
	p.d.Process(pcm16(silent, samplesPerFrame))
	p.d.Process(pcm16(silent, samplesPerFrame))
	if p.starts != 1 || p.ends != 1 || p.d.Speaking() {
		t.Errorf("starts %d ends %d speaking %v", p.starts, p.ends, p.d.Speaking())
	}
}

func TestMisalignedChunksNeitherLoseNorDuplicateFrames(t *testing.T) {
	p := newProbe(1)
	const odd = 101 // samples per chunk, coprime with the frame size
	for sent := 0; sent < 4*FrameBytes; sent += 2 * odd {
		p.d.Process(pcm16(loud, odd))
	}
	if !p.d.Speaking() || p.starts != 1 {
		t.Errorf("speaking %v starts %d", p.d.Speaking(), p.starts)
	}
}

func TestDetectorDefaults(t *testing.T) {
	d := NewDetector(Options{})
	if d.threshold != DefaultRMSThreshold || d.hysteresis != DefaultHysteresisFrames {
		t.Errorf("threshold %v hysteresis %d", d.threshold, d.hysteresis)
	}
	d.Process(pcm16(loud, 3*samplesPerFrame)) // nil callbacks must be safe
	if !d.Speaking() {
		t.Error("not speaking after three loud frames")
	}
}

func TestFallbackWarningIsOneShotPerAdapter(t *testing.T) {
	ResetFallbackWarnings()
	t.Cleanup(ResetFallbackWarnings)
	var got []string
	warn := func(s string) { got = append(got, s) }
	WarnFallbackOnce("FakeVoiceAdapter", warn)
	WarnFallbackOnce("FakeVoiceAdapter", warn)
	WarnFallbackOnce("AnotherFakeAdapter", warn)
	if len(got) != 2 {
		t.Fatalf("warnings %q", got)
	}
	if !strings.Contains(got[0], "FakeVoiceAdapter") || !strings.Contains(got[0], "no native VAD") ||
		!strings.Contains(got[0], "Accuracy may differ") {
		t.Errorf("warning text %q", got[0])
	}
}

func BenchmarkDetectorFrame(b *testing.B) {
	d := NewDetector(Options{})
	frame := pcm16(loud, 480) // a 20 ms transport chunk, misaligned to 30 ms frames
	b.ReportAllocs()
	for b.Loop() {
		d.Process(frame)
	}
}
