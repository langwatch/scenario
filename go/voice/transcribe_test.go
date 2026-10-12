package voice

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/stt"
)

// Ported from javascript/src/voice/__tests__/transcribe.test.ts.

var pcmBytes = []byte{1, 2, 3, 4, 5, 6, 7, 8}

func recording(segs ...AudioSegment) *VoiceRecording {
	for i := range segs {
		segs[i].StartTime, segs[i].EndTime = float64(i), float64(i+1)
		if segs[i].Audio == nil {
			segs[i].Audio = pcmBytes
		}
	}
	return &VoiceRecording{Segments: segs}
}

func constant(text string, calls *atomic.Int32) stt.Provider {
	return stt.ProviderFunc(func(context.Context, audio.Chunk) (string, error) {
		calls.Add(1)
		return text, nil
	})
}

func TestTranscribeFillsMissingTranscriptsInPlace(t *testing.T) {
	var calls atomic.Int32
	rec := recording(AudioSegment{Speaker: SpeakerAgent}, AudioSegment{Speaker: SpeakerAgent},
		AudioSegment{Speaker: SpeakerUser, Transcript: "already-here"})
	segs := rec.Segments
	TranscribeSegments(context.Background(), rec, constant("filled", &calls), TranscribeOptions{})
	if segs[0].Transcript != "filled" || segs[1].Transcript != "filled" {
		t.Errorf("transcripts %q %q", segs[0].Transcript, segs[1].Transcript)
	}
	if segs[2].Transcript != "already-here" || calls.Load() != 2 {
		t.Errorf("existing transcript %q, %d calls", segs[2].Transcript, calls.Load())
	}
}

func TestTranscribeOverwriteRetranscribesEverything(t *testing.T) {
	var calls atomic.Int32
	rec := recording(AudioSegment{Speaker: SpeakerUser, Transcript: "old"})
	TranscribeSegments(context.Background(), rec, constant("new", &calls), TranscribeOptions{Overwrite: true})
	if rec.Segments[0].Transcript != "new" {
		t.Errorf("transcript %q", rec.Segments[0].Transcript)
	}
}

func TestTranscribeWithoutProviderWarnsAndReturns(t *testing.T) {
	var warnings []string
	rec := recording(AudioSegment{Speaker: SpeakerAgent}, AudioSegment{Speaker: SpeakerUser})
	TranscribeSegments(context.Background(), rec, nil, TranscribeOptions{Warn: func(s string) { warnings = append(warnings, s) }})
	if len(warnings) != 1 || !strings.Contains(warnings[0], "no STT provider configured") {
		t.Errorf("warnings %q", warnings)
	}
	if rec.Segments[0].Transcript != "" || rec.Segments[1].Transcript != "" {
		t.Error("transcripts set without a provider")
	}
}

func TestTranscribeFailuresAreWarnedNotRaised(t *testing.T) {
	var warnings []string
	failing := stt.ProviderFunc(func(context.Context, audio.Chunk) (string, error) {
		return "", errors.New("upstream went down")
	})
	rec := recording(AudioSegment{Speaker: SpeakerAgent})
	TranscribeSegments(context.Background(), rec, failing, TranscribeOptions{Warn: func(s string) { warnings = append(warnings, s) }})
	if len(warnings) != 1 || !strings.Contains(warnings[0], "STT failed") || !strings.Contains(warnings[0], "upstream went down") {
		t.Errorf("warnings %q", warnings)
	}
	if rec.Segments[0].Transcript != "" {
		t.Error("failed segment got a transcript")
	}
}

func TestTranscribeSkipsEmptyRecordingsAndSilentSegments(t *testing.T) {
	var calls atomic.Int32
	TranscribeSegments(context.Background(), &VoiceRecording{}, constant("x", &calls), TranscribeOptions{})
	if calls.Load() != 0 {
		t.Error("provider called for an empty recording")
	}
	rec := recording(AudioSegment{Speaker: SpeakerAgent, Audio: []byte{}}, AudioSegment{Speaker: SpeakerUser})
	TranscribeSegments(context.Background(), rec, constant("x", &calls), TranscribeOptions{})
	if calls.Load() != 1 || rec.Segments[0].Transcript != "" || rec.Segments[1].Transcript != "x" {
		t.Errorf("%d calls, transcripts %q %q", calls.Load(), rec.Segments[0].Transcript, rec.Segments[1].Transcript)
	}
}

func TestTranscribeManySegmentsConcurrently(t *testing.T) {
	var calls atomic.Int32
	segs := make([]AudioSegment, 50)
	for i := range segs {
		segs[i].Speaker = SpeakerAgent
	}
	rec := recording(segs...)
	TranscribeSegments(context.Background(), rec, constant("ok", &calls), TranscribeOptions{})
	if calls.Load() != 50 {
		t.Errorf("%d calls", calls.Load())
	}
}
