//go:build integration

package live_test

import (
	"context"
	"os"
	"sync/atomic"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/internal/livetest"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/adapters/composable"
	"github.com/langwatch/scenario/go/voice/adapters/elevenlabs"
	"github.com/langwatch/scenario/go/voice/adapters/geminilive"
	"github.com/langwatch/scenario/go/voice/adapters/openairealtime"
	"github.com/langwatch/scenario/go/voice/adapters/pipecat"
	"github.com/langwatch/scenario/go/voice/stt"
)

// The voice scenarios run a real voice agent through scenario.Run with a
// voiced user simulator (OpenAI TTS) and a judge on the OpenAI LLM, which
// reads the agent's audio through the run's STT. The transport-level smoke
// tests of each adapter live next to the adapter in the voice module.

// voiceTimeout bounds one voice scenario.
const voiceTimeout = 4 * time.Minute

// userVoice is the voice of the simulated user.
const userVoice = "openai/nova"

func voiceUser(llm scenario.LLM) *voice.UserSimulator {
	return voice.NewUserSimulator(userSimulator(llm), voice.UserSimulatorOptions{Voice: userVoice})
}

// assertRecording checks the run recorded at least the given number of
// user and agent audio segments, each with audio.
func assertRecording(t *testing.T, res *scenario.ScenarioResult, users, agents int) {
	t.Helper()
	vr := voice.ResultOf(res)
	if vr == nil || vr.Recording == nil {
		t.Fatal("the run has no voice recording")
	}
	var u, a int
	for _, s := range vr.Recording.Segments {
		if len(s.Audio) == 0 {
			continue
		}
		switch s.Speaker {
		case voice.SpeakerUser:
			u++
		case voice.SpeakerAgent:
			a++
		}
	}
	if u < users || a < agents {
		t.Errorf("recording has %d user and %d agent segments with audio, want %d and %d", u, a, users, agents)
	}
}

// countingSTT counts the transcriptions it serves.
type countingSTT struct {
	stt.Provider
	calls atomic.Int32
}

func (c *countingSTT) Transcribe(ctx context.Context, chunk voice.AudioChunk) (string, error) {
	c.calls.Add(1)
	return c.Provider.Transcribe(ctx, chunk)
}

// TestLiveVoiceComposableAgent runs the composable STT -> LLM -> TTS agent
// (OpenAI for all three) through a judged scenario. Needs OPENAI_API_KEY.
func TestLiveVoiceComposableAgent(t *testing.T) {
	llm := requireOpenAI(t)
	ctx := livetest.Context(t, voiceTimeout)
	agent, err := composable.NewAgent(composable.Options{
		STT:          stt.NewOpenAI(stt.OpenAIOptions{}),
		LLM:          llm,
		Model:        model(),
		Voice:        "openai/alloy",
		SystemPrompt: "You are the voice assistant of a bakery that is open from 7am to 3pm every day. Answer in one short sentence.",
	})
	if err != nil {
		t.Fatal(err)
	}
	const question = "Hi, what are your opening hours?"
	criteria := []string{"The agent tells the user the bakery opens at 7am and closes at 3pm"}
	res, err := scenario.Run(ctx, scenario.ScenarioConfig{
		Name:        "go live voice: composable agent",
		Description: "A customer calls the bakery to ask for its opening hours.",
		Agents:      []scenario.AgentAdapter{agent, voiceUser(llm), judge(llm, criteria...)},
		Script:      []scenario.ScriptStep{scenario.User(question), scenario.Agent(), scenario.Judge()},
		MaxTurns:    2,
		SetID:       livetest.SetID,
	})
	livetest.AssertVerdict(t, res, err, criteria)
	assertRecording(t, res, 1, 1)
	heard := agent.Composable().LastUserTranscript()
	if livetest.WordOverlap(question, heard) < 0.6 {
		t.Errorf("the agent's STT heard %q for %q", heard, question)
	}
}

// TestLiveVoiceOpenAIRealtimeAgent is the port of openai-realtime-agent:
// the Realtime model is the agent under test over a two-exchange voice
// conversation. Needs OPENAI_API_KEY.
func TestLiveVoiceOpenAIRealtimeAgent(t *testing.T) {
	llm := requireOpenAI(t)
	ctx := livetest.Context(t, voiceTimeout)
	agent := openairealtime.New(openairealtime.Options{
		Instructions: "You are a helpful travel assistant. Keep responses brief: one short sentence.",
	})
	criteria := []string{
		"The agent responded to the user's request for help planning a trip",
		"The agent answered the packing question on topic",
	}
	res, err := scenario.Run(ctx, scenario.ScenarioConfig{
		Name:        "go live voice: openai realtime agent",
		Description: "A user plans a cold-weather weekend trip with a voice assistant.",
		Agents:      []scenario.AgentAdapter{agent, voiceUser(llm), judge(llm, criteria...)},
		Script: []scenario.ScriptStep{
			scenario.User("Hello, can you help me plan a weekend trip?"),
			scenario.Agent(),
			scenario.User("Great, what should I pack for cold weather?"),
			scenario.Agent(),
			scenario.Judge(),
		},
		MaxTurns: 3,
		SetID:    livetest.SetID,
	})
	livetest.AssertVerdict(t, res, err, criteria)
	assertRecording(t, res, 2, 2)
}

// TestLiveVoiceOpenAIRealtimeUser is the port of openai-realtime-user: the
// Realtime model plays the user, speaking the scripted line itself, to a
// composable agent. Needs OPENAI_API_KEY.
func TestLiveVoiceOpenAIRealtimeUser(t *testing.T) {
	llm := requireOpenAI(t)
	ctx := livetest.Context(t, voiceTimeout)
	agent, err := composable.NewAgent(composable.Options{
		STT: stt.NewOpenAI(stt.OpenAIOptions{}), LLM: llm, Model: model(), Voice: "openai/alloy",
		SystemPrompt: "You are a pizzeria's phone assistant. Margherita costs 9 euros. Answer in one short sentence.",
	})
	if err != nil {
		t.Fatal(err)
	}
	user := openairealtime.New(openairealtime.Options{
		Role:         scenario.AgentRoleUser,
		Instructions: "You are a customer calling a pizzeria to ask what a margherita costs. Speak briefly.",
	})
	criteria := []string{"The agent tells the user a margherita costs 9 euros"}
	res, err := scenario.Run(ctx, scenario.ScenarioConfig{
		Name:        "go live voice: openai realtime user",
		Description: "A customer asks the pizzeria what a margherita costs.",
		Agents:      []scenario.AgentAdapter{agent, user, judge(llm, criteria...)},
		Script: []scenario.ScriptStep{
			scenario.User("Hi, how much is a margherita pizza?"),
			scenario.Agent(),
			scenario.Judge(),
		},
		MaxTurns: 2,
		SetID:    livetest.SetID,
	})
	livetest.AssertVerdict(t, res, err, criteria)
	assertRecording(t, res, 1, 1)
}

// TestLiveVoiceJudgeSTTSwap is the port of composable-stt-swap: the run's
// STT is swapped to ElevenLabs with voice.WithConfig, and the swapped
// provider (not the default OpenAI one) transcribes the Realtime agent's
// audio turns for the judge. Needs OPENAI_API_KEY and ELEVENLABS_API_KEY.
func TestLiveVoiceJudgeSTTSwap(t *testing.T) {
	llm := requireOpenAI(t)
	livetest.Require(t, "ELEVENLABS_API_KEY")
	ctx := livetest.Context(t, voiceTimeout)
	swapped := &countingSTT{Provider: stt.NewElevenLabs(stt.ElevenLabsOptions{})}
	agent := openairealtime.New(openairealtime.Options{Instructions: "You are a helpful assistant. Keep responses brief."})
	criteria := []string{"The agent responded helpfully across both turns"}
	res, err := scenario.Run(ctx, scenario.ScenarioConfig{
		Name:        "go live voice: judge stt swap",
		Description: "A user asks a voice assistant two quick questions.",
		Agents:      []scenario.AgentAdapter{agent, voiceUser(llm), judge(llm, criteria...)},
		Script: []scenario.ScriptStep{
			scenario.User("Hello, can you help me with a quick question?"),
			scenario.Agent(),
			scenario.User("Thanks. What is the capital of Portugal?"),
			scenario.Agent(),
			scenario.Judge(),
		},
		MaxTurns: 3,
		SetID:    livetest.SetID,
	}, voice.WithConfig(voice.Config{STT: swapped}))
	if err != nil {
		t.Fatal(err)
	}
	if swapped.calls.Load() == 0 {
		t.Fatal("the swapped ElevenLabs STT never ran: the judge fell back to the default")
	}
	t.Logf("ElevenLabs STT calls: %d, success %v", swapped.calls.Load(), res.Success)
	livetest.AssertVerdict(t, res, err, criteria)
}

// TestLiveVoiceGeminiLiveAgent is the port of gemini-live: Gemini Live is
// the agent under test. Needs GEMINI_API_KEY (or GOOGLE_API_KEY) and
// OPENAI_API_KEY (user voice and judge).
func TestLiveVoiceGeminiLiveAgent(t *testing.T) {
	livetest.RequireAny(t, "GEMINI_API_KEY", "GOOGLE_API_KEY")
	llm := requireOpenAI(t)
	ctx := livetest.Context(t, voiceTimeout)
	agent := geminilive.New(geminilive.Options{SystemInstruction: "You are a geography tutor. Answer in one short sentence."})
	criteria := []string{"The agent says the capital of France is Paris"}
	res, err := scenario.Run(ctx, scenario.ScenarioConfig{
		Name:        "go live voice: gemini live agent",
		Description: "A student asks a voice tutor for the capital of France.",
		Agents:      []scenario.AgentAdapter{agent, voiceUser(llm), judge(llm, criteria...)},
		Script:      []scenario.ScriptStep{scenario.User("Hi, what is the capital of France?"), scenario.Agent(), scenario.Judge()},
		MaxTurns:    2,
		SetID:       livetest.SetID,
	})
	livetest.AssertVerdict(t, res, err, criteria)
	assertRecording(t, res, 1, 1)
}

// TestLiveVoiceElevenLabsHostedAgent is the port of elevenlabs-hosted: a
// hosted ElevenLabs Conversational AI agent is the agent under test. Its
// persona is the operator's, so the criterion only asks for a relevant
// answer. Needs ELEVENLABS_AGENT_ID, ELEVENLABS_API_KEY (or
// ELEVENLABS_CONVAI_API_KEY) and OPENAI_API_KEY.
func TestLiveVoiceElevenLabsHostedAgent(t *testing.T) {
	livetest.Require(t, "ELEVENLABS_AGENT_ID")
	livetest.RequireAny(t, "ELEVENLABS_API_KEY", "ELEVENLABS_CONVAI_API_KEY")
	llm := requireOpenAI(t)
	ctx := livetest.Context(t, voiceTimeout)
	agent, err := elevenlabs.NewAgent(elevenlabs.Options{AgentID: os.Getenv("ELEVENLABS_AGENT_ID")})
	if err != nil {
		t.Fatal(err)
	}
	criteria := []string{"The agent responds to what the user said"}
	res, err := scenario.Run(ctx, scenario.ScenarioConfig{
		Name:        "go live voice: elevenlabs hosted agent",
		Description: "A caller greets the hosted voice agent and asks what it can help with.",
		Agents:      []scenario.AgentAdapter{agent, voiceUser(llm), judge(llm, criteria...)},
		Script: []scenario.ScriptStep{
			scenario.Agent(), // the hosted agent greets first
			scenario.User("Hi, what can you help me with?"),
			scenario.Agent(),
			scenario.Judge(),
		},
		MaxTurns: 3,
		SetID:    livetest.SetID,
	})
	livetest.AssertVerdict(t, res, err, criteria)
	assertRecording(t, res, 1, 1)
}

// TestLiveVoicePipecatAgent is the port of pipecat-scenario: a running
// Pipecat bot (for example `make voice-pipecat-up`) is the agent under
// test. Needs PIPECAT_URL (or PIPECAT_BOT_URL), such as
// ws://localhost:8765/ws, and OPENAI_API_KEY.
func TestLiveVoicePipecatAgent(t *testing.T) {
	url := livetest.RequireAny(t, "PIPECAT_URL", "PIPECAT_BOT_URL")
	llm := requireOpenAI(t)
	ctx := livetest.Context(t, voiceTimeout)
	bot, err := pipecat.New(pipecat.Options{URL: url})
	if err != nil {
		t.Fatal(err)
	}
	criteria := []string{"The agent responds to the user's greeting"}
	res, err := scenario.Run(ctx, scenario.ScenarioConfig{
		Name:        "go live voice: pipecat bot",
		Description: "A caller greets the Pipecat bot.",
		Agents:      []scenario.AgentAdapter{voice.NewAgent(bot), voiceUser(llm), judge(llm, criteria...)},
		Script:      []scenario.ScriptStep{scenario.User("Hello, is anyone there?"), scenario.Agent(), scenario.Judge()},
		MaxTurns:    2,
		SetID:       livetest.SetID,
	})
	livetest.AssertVerdict(t, res, err, criteria)
	assertRecording(t, res, 1, 1)
}
