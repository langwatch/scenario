package voice_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/voicetest"
)

func TestAudioMessageShape(t *testing.T) {
	c := voicetest.Tone(0.01, "")
	m := voice.AudioMessage(c, scenario.RoleUser)
	if m.Role != scenario.RoleUser || len(m.Parts) != 1 || m.Parts[0].MediaType != "audio/pcm16" || !bytes.Equal(m.Parts[0].Data, c.Data) {
		t.Fatalf("%+v", m)
	}
	if bytes.HasPrefix(m.Parts[0].Data, []byte("RIFF")) {
		t.Error("the payload is WAV, not raw PCM16")
	}
	m = voice.AudioMessage(voicetest.Tone(0.01, "hi"), scenario.RoleAssistant)
	if m.Role != scenario.RoleAssistant || len(m.Parts) != 2 || m.Parts[0].Type != scenario.PartText || m.Parts[0].Text != "hi" || !m.Parts[1].IsAudio() {
		t.Fatalf("transcript must precede audio: %+v", m.Parts)
	}
}

func TestExtractAudioRoundTrip(t *testing.T) {
	c := voicetest.Tone(0.02, "words")
	got, ok := voice.ExtractAudio(voice.AudioMessage(c, scenario.RoleUser))
	if !ok || !bytes.Equal(got.Data, c.Data) || got.Transcript != "words" {
		t.Fatalf("round trip lost data: ok=%v %q", ok, got.Transcript)
	}
}

func TestExtractAudioRejects(t *testing.T) {
	for name, m := range map[string]scenario.Message{
		"text":       scenario.UserMsg("hi"),
		"no audio":   {Role: scenario.RoleUser, Parts: []scenario.Part{scenario.TextPart("x"), scenario.ImagePart("image/png", []byte{1})}},
		"url only":   {Role: scenario.RoleUser, Parts: []scenario.Part{{Type: scenario.PartFile, MediaType: "audio/wav", URL: "https://x"}}},
		"odd length": {Role: scenario.RoleUser, Parts: []scenario.Part{scenario.AudioPart("audio/pcm16", []byte{1, 2, 3})}},
	} {
		if _, ok := voice.ExtractAudio(m); ok {
			t.Errorf("%s: extracted audio", name)
		}
		if voice.MessageHasAudio(m) {
			t.Errorf("%s: MessageHasAudio", name)
		}
	}
}

func TestExtractAudioFirstOfSeveral(t *testing.T) {
	a, b := voicetest.Tone(0.01, ""), voicetest.Tone(0.02, "")
	m := scenario.Message{Role: scenario.RoleUser, Parts: []scenario.Part{scenario.AudioPart("audio/pcm16", a.Data), scenario.AudioPart("audio/pcm16", b.Data)}}
	if got, _ := voice.ExtractAudio(m); len(got.Data) != len(a.Data) {
		t.Error("not the first audio part")
	}
}

func TestExtractAudioUnwrapsLegacyWAV(t *testing.T) {
	pcm := voicetest.Tone(0.01, "").Data
	wav := audio.AppendWAV(nil, pcm)
	raw, _ := json.Marshal(map[string]any{"type": "input_audio", "input_audio": map[string]any{
		"data": base64.StdEncoding.EncodeToString(wav), "format": "wav", "transcript": "legacy",
	}})
	m := scenario.Message{Role: scenario.RoleUser, Parts: []scenario.Part{{Type: "input_audio", Raw: raw}}}
	got, ok := voice.ExtractAudio(m)
	if !ok || !bytes.Equal(got.Data, pcm) || got.Transcript != "legacy" {
		t.Fatalf("legacy part: ok=%v len=%d tx=%q", ok, len(got.Data), got.Transcript)
	}
	m2 := scenario.Message{Role: scenario.RoleUser, Parts: []scenario.Part{scenario.AudioPart("audio/wav", wav)}}
	if got, _ := voice.ExtractAudio(m2); !bytes.Equal(got.Data, pcm) {
		t.Error("WAV file part not unwrapped")
	}
}

func TestExtractTranscript(t *testing.T) {
	if tx, ok := voice.ExtractTranscript(voice.AudioMessage(voicetest.Tone(0.01, "lead"), scenario.RoleUser)); !ok || tx != "lead" {
		t.Error(tx)
	}
	if _, ok := voice.ExtractTranscript(voice.AudioMessage(voicetest.Tone(0.01, ""), scenario.RoleUser)); ok {
		t.Error("transcript without a text part")
	}
}

// --- recording save ----------------------------------------------------------

func segment(speaker voice.Speaker, start, end float64, transcript string) voice.AudioSegment {
	return voice.AudioSegment{Speaker: speaker, StartTime: start, EndTime: end, Audio: voicetest.Tone(end-start, "").Data, Transcript: transcript}
}

func TestSaveWritesCanonicalWAV(t *testing.T) {
	rec := &voice.VoiceRecording{Segments: []voice.AudioSegment{segment(voice.SpeakerAgent, 0.1, 0.3, ""), segment(voice.SpeakerUser, 0, 0.1, "")}}
	path, err := rec.Save(t.Context(), filepath.Join(t.TempDir(), "out.wav"), "")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	w, err := audio.ParseWAV(b)
	if err != nil || w.Format != audio.Canonical {
		t.Fatalf("%v %+v", err, w.Format)
	}
	if !bytes.Equal(w.Data[:len(rec.Segments[1].Audio)], rec.Segments[1].Audio) {
		t.Error("segments not in time order")
	}
	if math.Abs(rec.Duration()-0.3) > 1e-12 {
		t.Errorf("duration %v", rec.Duration())
	}
}

func TestSaveRejectsUnknownFormats(t *testing.T) {
	rec := &voice.VoiceRecording{}
	_, err := rec.Save(t.Context(), filepath.Join(t.TempDir(), "out.aiff"), "")
	if err == nil || !strings.Contains(err.Error(), "allowed: flac, mp3, ogg, wav") {
		t.Fatalf("got %v", err)
	}
}

func TestSaveSegmentsLayoutAndManifest(t *testing.T) {
	rec := &voice.VoiceRecording{
		Segments: []voice.AudioSegment{segment(voice.SpeakerUser, 0, 0.1, "hi"), segment(voice.SpeakerAgent, 0.1, 0.312, "")},
		Timeline: []voice.VoiceEvent{{Type: voice.AgentStartSpeaking, Time: 0.1, Latency: ptr(0.25)}, {Type: voice.UserStartSpeaking, Time: 0}},
	}
	rec.Segments[1].TranscriptTruncated = true
	dir, err := rec.SaveSegments(t.TempDir(), voice.SaveSegmentsOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"segments/00-user-0000ms.wav", "segments/01-agent-0100ms.wav", "full.wav", "manifest.json"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			t.Errorf("missing %s", f)
		}
	}
	var m map[string]any
	b, _ := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	segs := m["segments"].([]any)
	first, second := segs[0].(map[string]any), segs[1].(map[string]any)
	if first["transcript"] != "hi" || second["transcript"] != nil || second["transcript_truncated"] != true {
		t.Errorf("segments %v", segs)
	}
	if _, ok := first["transcript_truncated"]; ok {
		t.Error("transcript_truncated on a full segment")
	}
	events := m["events"].([]any)
	if events[0].(map[string]any)["type"] != "user_start_speaking" || events[1].(map[string]any)["latency"] != 0.25 {
		t.Errorf("events %v", events)
	}
	if m["segment_count"] != 2.0 {
		t.Errorf("segment_count %v", m["segment_count"])
	}

	dir2, _ := rec.SaveSegments(t.TempDir(), voice.SaveSegmentsOptions{NoManifest: true})
	if _, err := os.Stat(filepath.Join(dir2, "manifest.json")); err == nil {
		t.Error("manifest written although disabled")
	}
}

func ptr(f float64) *float64 { return &f }

func TestComputeLatencyMetrics(t *testing.T) {
	m := voice.ComputeLatencyMetrics([]float64{0.4, 0.1, 0.3, 0.2}, ptr(0.4), nil)
	if math.Abs(*m.AvgResponseTime-0.25) > 1e-12 || *m.P50ResponseTime != 0.2 || *m.P95ResponseTime != 0.4 || *m.TimeToFirstByte != 0.4 {
		t.Errorf("%+v", m)
	}
	empty := voice.ComputeLatencyMetrics(nil, nil, nil)
	if empty.AvgResponseTime != nil || empty.P50ResponseTime != nil || empty.Measurements == nil {
		t.Errorf("%+v", empty)
	}
}

func TestInterruptionConfigDefaults(t *testing.T) {
	c := voice.NewInterruptionConfig(0.3)
	if c.Strategy != voice.StrategyRandomPhrase || c.DelayRange != [2]float64{0.5, 3} || len(c.Phrases) != 7 {
		t.Errorf("%+v", c)
	}
	custom := voice.InterruptionConfig{Phrases: []string{"a", "b"}}
	if custom.PickRandomPhrase(func() float64 { return 0.99 }) != "b" || custom.PickRandomPhrase(func() float64 { return 0 }) != "a" {
		t.Error("custom pool")
	}
	if !strings.Contains(voice.ContextualPrompt, "SHORT") {
		t.Error("contextual prompt")
	}
}
