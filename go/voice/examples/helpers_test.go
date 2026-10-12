package examples

import (
	"os"
	"path/filepath"
	"slices"
	"sort"
	"testing"

	scenario "github.com/langwatch/scenario/go"
	scenarioopenai "github.com/langwatch/scenario/go/providers/openai"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/stt"
	"github.com/openai/openai-go/v3"
)

// model drives the user simulators and judges of the examples.
const model = "gpt-4.1-mini"

// defaultPipecatURL is where the bundled Pipecat bot listens
// (python/examples/voice/_bot, `make voice-pipecat-up`).
const defaultPipecatURL = "ws://localhost:8765/stream"

// skipWithout skips the test unless every named environment variable is set.
func skipWithout(t *testing.T, keys ...string) {
	t.Helper()
	for _, k := range keys {
		if os.Getenv(k) == "" {
			t.Skip(k + " not set")
		}
	}
}

// skipWithoutAny skips the test unless at least one of keys is set.
func skipWithoutAny(t *testing.T, keys ...string) {
	t.Helper()
	if !slices.ContainsFunc(keys, func(k string) bool { return os.Getenv(k) != "" }) {
		t.Skipf("none of %v set", keys)
	}
}

// skipWithoutOpenAI skips examples that call OpenAI (TTS, STT, the judge)
// when no key is set.
func skipWithoutOpenAI(t *testing.T) {
	t.Helper()
	skipWithout(t, "OPENAI_API_KEY")
}

// skipWithoutElevenLabsAgent skips the hosted ElevenLabs examples unless a
// ConvAI key (the adapter reads ELEVENLABS_CONVAI_API_KEY, then
// ELEVENLABS_API_KEY) and ELEVENLABS_AGENT_ID are set. It returns the agent id.
func skipWithoutElevenLabsAgent(t *testing.T) string {
	t.Helper()
	skipWithoutAny(t, "ELEVENLABS_CONVAI_API_KEY", "ELEVENLABS_API_KEY")
	skipWithout(t, "ELEVENLABS_AGENT_ID")
	return os.Getenv("ELEVENLABS_AGENT_ID")
}

// pipecatURL skips the Pipecat examples unless the bot is up
// (SCENARIO_PIPECAT_BOT_UP=1, the convention of the JavaScript and Python
// demos) and returns its WebSocket URL: PIPECAT_BOT_URL, else the bundled
// bot's default.
func pipecatURL(t *testing.T) string {
	t.Helper()
	skipWithoutOpenAI(t)
	if os.Getenv("SCENARIO_PIPECAT_BOT_UP") != "1" {
		t.Skip("SCENARIO_PIPECAT_BOT_UP != 1 (start the Pipecat bot first)")
	}
	if u := os.Getenv("PIPECAT_BOT_URL"); u != "" {
		return u
	}
	return defaultPipecatURL
}

// newLLM is the OpenAI-backed model of the user simulators and judges.
func newLLM() scenario.LLM {
	client := openai.NewClient() // uses OPENAI_API_KEY
	return scenarioopenai.NewProvider(&client)
}

func modelConfig() scenario.ModelConfig {
	return scenario.ModelConfig{LLM: newLLM(), Model: model}
}

// voiceUser is a user simulator that speaks: every turn it generates, and
// every scripted line, is synthesized with voiceName ("provider/voice").
func voiceUser(voiceName, persona string, opts ...func(*voice.UserSimulatorOptions)) *voice.UserSimulator {
	o := voice.UserSimulatorOptions{Voice: voiceName}
	for _, f := range opts {
		f(&o)
	}
	return voice.NewUserSimulator(scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{
		ModelConfig: modelConfig(),
		Persona:     persona,
	}), o)
}

// judge returns a judge with the given criteria. The voice session
// transcribes every audio turn for it and adds the voice timeline.
func judge(criteria ...string) *scenario.JudgeAgent {
	return scenario.NewJudgeAgent(scenario.JudgeAgentConfig{
		ModelConfig: modelConfig(),
		Criteria:    criteria,
	})
}

// run executes a scenario and fails the test when it errored.
func run(t *testing.T, cfg scenario.ScenarioConfig, opts ...scenario.RunOption) *scenario.ScenarioResult {
	t.Helper()
	if cfg.SetID == "" {
		cfg.SetID = "go-voice-examples"
	}
	res, err := scenario.Run(t.Context(), cfg, opts...)
	if err != nil {
		t.Fatalf("scenario.Run: %v", err)
	}
	return res
}

// requireSuccess fails the test when the judge's verdict was negative.
func requireSuccess(t *testing.T, res *scenario.ScenarioResult) {
	t.Helper()
	if !res.Success {
		t.Fatalf("scenario failed: %s (unmet: %v)", res.Reasoning, res.UnmetCriteria)
	}
}

// voiceResult returns the voice part of a result, failing the test when the
// run recorded no audio.
func voiceResult(t *testing.T, res *scenario.ScenarioResult) *voice.Result {
	t.Helper()
	vr := voice.ResultOf(res)
	if vr == nil || vr.Recording == nil {
		t.Fatal("the run recorded no audio")
	}
	return vr
}

// segmentsOf returns the recorded segments of one speaker.
func segmentsOf(rec *voice.VoiceRecording, who voice.Speaker) []voice.AudioSegment {
	var out []voice.AudioSegment
	for _, s := range rec.Segments {
		if s.Speaker == who {
			out = append(out, s)
		}
	}
	return out
}

// interruptsOf returns the user_interrupt events of a timeline.
func interruptsOf(timeline []voice.VoiceEvent) []voice.VoiceEvent {
	var out []voice.VoiceEvent
	for _, e := range timeline {
		if e.Type == voice.UserInterrupt {
			out = append(out, e)
		}
	}
	return out
}

// requireTurns fails unless the recording holds at least n user and n agent
// segments, and every user segment carries audio.
func requireTurns(t *testing.T, rec *voice.VoiceRecording, users, agents int) {
	t.Helper()
	u, a := segmentsOf(rec, voice.SpeakerUser), segmentsOf(rec, voice.SpeakerAgent)
	if len(u) < users || len(a) < agents {
		t.Fatalf("recorded %d user and %d agent segments, want at least %d and %d", len(u), len(a), users, agents)
	}
	for i, s := range u {
		if len(s.Audio) == 0 {
			t.Fatalf("user segment %d carried no audio", i)
		}
	}
}

// requireSpokenUserTurns re-transcribes every user segment from its audio,
// overwriting the transcript the run attached, and fails unless each one
// holds speech: proof the user side spoke rather than committing text.
func requireSpokenUserTurns(t *testing.T, rec *voice.VoiceRecording) {
	t.Helper()
	users := &voice.VoiceRecording{Segments: segmentsOf(rec, voice.SpeakerUser)}
	for i := range users.Segments {
		users.Segments[i].Transcript = ""
	}
	voice.TranscribeSegments(t.Context(), users, stt.NewOpenAI(stt.OpenAIOptions{}), voice.TranscribeOptions{Overwrite: true})
	for i, s := range users.Segments {
		if s.Transcript == "" {
			t.Fatalf("STT over user segment %d returned nothing: the turn was not audio", i)
		}
	}
}

// saveRecording writes full.wav, one WAV per segment and manifest.json under
// $SCENARIO_RECORDINGS_DIR/<name> (default: the system temp dir) and logs
// where.
func saveRecording(t *testing.T, rec *voice.VoiceRecording, name string) string {
	t.Helper()
	root := os.Getenv("SCENARIO_RECORDINGS_DIR")
	if root == "" {
		root = filepath.Join(os.TempDir(), "scenario-voice-recordings")
	}
	dir, err := rec.SaveSegments(filepath.Join(root, name), voice.SaveSegmentsOptions{})
	if err != nil {
		t.Fatalf("save recording: %v", err)
	}
	t.Logf("recording: %s (%d segments, %.1fs)", dir, len(rec.Segments), rec.Duration())
	return dir
}

// noiseFloorRMS is the RMS of the quietest 20 ms frames (the 10th
// percentile) of a PCM16 segment. Clean TTS has near-silent gaps; mixed-in
// ambience lifts the floor across the whole segment.
func noiseFloorRMS(pcm []byte) float64 {
	const frame = 2 * 480 // 20 ms at 24 kHz
	var rms []float64
	for i := 0; i+frame <= len(pcm); i += frame {
		rms = append(rms, audio.RMS(pcm[i:i+frame]))
	}
	if len(rms) == 0 {
		return 0
	}
	sort.Float64s(rms)
	return rms[len(rms)/10]
}
