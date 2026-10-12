// Example: Recording and Playback
//
// Every voice run carries its recording: voice.ResultOf(res).Recording.
// Save writes the whole conversation in one file (WAV natively; MP3, OGG
// and FLAC through ffmpeg), SaveSegments writes one WAV per turn plus
// full.wav and a manifest. Config.AudioPlayback streams the conversation to
// the local speakers while it runs (set SCENARIO_AUDIO_PLAYBACK=1); without
// ffmpeg or an audio device it warns once and drops the audio.
//
// Mirrors: javascript/examples/vitest/tests/voice/recording-playback.test.ts
package examples

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/adapters/openairealtime"
	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/ffmpeg"
)

func TestRecordingPlayback(t *testing.T) {
	skipWithoutOpenAI(t)

	res := run(t, scenario.ScenarioConfig{
		Name: "demo_recording_playback",
		Description: "Record a voice conversation and save it as WAV + MP3. " +
			"The user greets, the agent responds; the recording is saved in both formats.",
		Agents: []scenario.AgentAdapter{
			openairealtime.New(openairealtime.Options{
				Voice:        "alloy",
				Instructions: "You are a helpful assistant. Keep responses brief.",
			}),
			voiceUser("openai/nova", ""),
			judge(
				"The agent responded helpfully across both turns",
				"The agent and user produced enough audio to save a non-empty recording",
			),
		},
		Script: []scenario.ScriptStep{
			scenario.User("Hello, can you help me?"),
			scenario.Agent(),
			scenario.User("Can you also tell me a fun fact?"),
			scenario.Agent(),
			scenario.Judge(),
		},
		MaxTurns: 6,
	}, voice.WithConfig(voice.Config{AudioPlayback: os.Getenv("SCENARIO_AUDIO_PLAYBACK") == "1"}))

	rec := voiceResult(t, res).Recording
	dir := t.TempDir()

	// WAV is written natively: no ffmpeg needed.
	wavPath, err := rec.Save(t.Context(), filepath.Join(dir, "demo.wav"), "")
	if err != nil {
		t.Fatal(err)
	}
	if st, err := os.Stat(wavPath); err != nil || st.Size() <= audio.WAVHeaderSize {
		t.Fatalf("demo.wav is empty (%v)", err)
	}

	// MP3 is transcoded through ffmpeg ($SCENARIO_FFMPEG, else PATH).
	if _, err := ffmpeg.Path(); errors.Is(err, ffmpeg.ErrNotFound) {
		t.Log("ffmpeg not found: skipping the MP3 save")
	} else {
		mp3Path, err := rec.Save(t.Context(), filepath.Join(dir, "demo.mp3"), "")
		if err != nil {
			t.Fatal(err)
		}
		if st, err := os.Stat(mp3Path); err != nil || st.Size() == 0 {
			t.Fatalf("demo.mp3 is empty (%v)", err)
		}
	}

	saveRecording(t, rec, "recording_playback")
	t.Logf("judge: success=%v", res.Success)
}
