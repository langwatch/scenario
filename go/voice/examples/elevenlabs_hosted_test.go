// Example: ElevenLabs Hosted Agent (and the ElevenLabs Composable Agent)
//
// Hosted: a live ElevenLabs Conversational AI agent is the agent under test
// over its WebSocket. The agent greets on connect, so the script leads with
// an agent step to drain the greeting before user audio goes out; each user
// turn is streamed as real PCM at microphone cadence so the agent's own STT
// and VAD run on it.
//
// Composable: the same vendor's STT and TTS run in-process around an LLM
// (composable.NewElevenLabsAgent): no socket, and every seam can be swapped.
//
// Mirrors: javascript/examples/vitest/tests/voice/elevenlabs-hosted.test.ts
package examples

import (
	"os"
	"testing"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice/adapters/composable"
	"github.com/langwatch/scenario/go/voice/adapters/elevenlabs"
)

func TestElevenLabsHosted(t *testing.T) {
	skipWithoutOpenAI(t)
	agentID := skipWithoutElevenLabsAgent(t)

	// The adapter reads ELEVENLABS_BASE_URL itself, so the same test runs
	// against ElevenLabs or a gateway in front of it.
	agent, err := elevenlabs.NewAgent(elevenlabs.Options{AgentID: agentID})
	if err != nil {
		t.Fatal(err)
	}

	res := run(t, scenario.ScenarioConfig{
		Name: "demo_elevenlabs_hosted",
		Description: "Happy path against a live ElevenLabs Conversational AI agent. " +
			"The greeting plays on connect, the user asks a question, the agent " +
			"responds; judge evaluates naturalness.",
		Agents: []scenario.AgentAdapter{
			agent,
			voiceUser("openai/nova", ""),
			judge(
				"The agent's greeting (sent on connect) is natural and conversational",
				"The agent and user exchanged audio turns via the live WebSocket",
				"The conversation is a coherent example of the hosted ElevenLabs ConvAI path",
			),
		},
		Script: []scenario.ScriptStep{
			scenario.Agent(), // the greeting
			scenario.User("Hello, I have a question about my account."),
			scenario.Agent(),
			scenario.User("Thanks. Can you tell me your support hours?"),
			scenario.Agent(),
			scenario.Judge(),
		},
		MaxTurns: 8,
	})

	rec := voiceResult(t, res).Recording
	saveRecording(t, rec, "elevenlabs_hosted")
	// greeting + user1 + agent1 + user2 + agent2
	if len(rec.Segments) < 5 {
		t.Fatalf("expected at least 5 segments, got %d", len(rec.Segments))
	}
	t.Logf("conversation id %s", agent.ConvAI().ConversationID())
	requireSuccess(t, res)
}

func TestElevenLabsComposable(t *testing.T) {
	skipWithoutOpenAI(t)
	skipWithout(t, "ELEVENLABS_API_KEY")

	agent, err := composable.NewElevenLabsAgent(composable.ElevenLabsOptions{
		APIKey: os.Getenv("ELEVENLABS_API_KEY"),
		// Go links no LLM by default: pass the one the JavaScript preset uses.
		LLM:   newLLM(),
		Model: composable.DefaultLLMModel,
		SystemPrompt: "You are a friendly support agent. Keep every reply to ONE short " +
			"sentence (under 15 words).",
	})
	if err != nil {
		t.Fatal(err)
	}

	res := run(t, scenario.ScenarioConfig{
		Name: "demo_elevenlabs_branded",
		Description: "Composable ElevenLabs agent: ElevenLabs STT + an LLM + " +
			"ElevenLabs TTS. The user greets, the agent responds; judge passes.",
		Agents: []scenario.AgentAdapter{
			agent,
			voiceUser("openai/nova", ""),
			judge(
				"The agent responded naturally across both turns",
				"The user simulator delivered audio and the agent responded with audio",
				"The conversation is a coherent multi-turn ElevenLabs composable exchange",
			),
		},
		// No hosted greeting: start with the user.
		Script: []scenario.ScriptStep{
			scenario.User("Hi there, I have a quick question about my plan."),
			scenario.Agent(),
			scenario.User("Got it — can I switch to an annual plan?"),
			scenario.Agent(),
			scenario.User("Thanks — would my price change right away?"),
			scenario.Agent(),
			scenario.Judge(),
		},
		MaxTurns: 10,
	})

	// Each seam fired: STT heard the user, the LLM answered.
	seams := agent.Composable()
	if seams.LastUserTranscript() == "" {
		t.Error("the STT seam produced no user transcript")
	}
	if seams.LastLLMResponse() == "" {
		t.Error("the LLM seam produced no reply")
	}

	rec := voiceResult(t, res).Recording
	saveRecording(t, rec, "elevenlabs_branded")
	requireTurns(t, rec, 3, 3)
	requireSpokenUserTurns(t, rec)
	requireSuccess(t, res)
}
