// Example: Swapping the Judge's STT
//
// The speech-to-text that transcribes audio turns for the judge is a
// per-run setting: voice.WithConfig(voice.Config{STT: ...}). Here the
// default OpenAI STT is swapped for ElevenLabs. The judge only ever sees
// text, so the swap is verified by counting the calls an instrumented
// provider receives.
//
// Mirrors: javascript/examples/vitest/tests/voice/composable-stt-swap.test.ts
package examples

import (
	"context"
	"os"
	"sync/atomic"
	"testing"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/adapters/openairealtime"
	"github.com/langwatch/scenario/go/voice/stt"
)

func TestComposableSTTSwap(t *testing.T) {
	skipWithoutOpenAI(t)
	skipWithout(t, "ELEVENLABS_API_KEY")

	base := stt.NewElevenLabs(stt.ElevenLabsOptions{APIKey: os.Getenv("ELEVENLABS_API_KEY")})
	var calls atomic.Int32
	counted := stt.ProviderFunc(func(ctx context.Context, chunk voice.AudioChunk) (string, error) {
		calls.Add(1)
		return base.Transcribe(ctx, chunk)
	})

	res := run(t, scenario.ScenarioConfig{
		Name: "demo_composable_stt_swap",
		Description: "Swap the judge's STT to ElevenLabs via voice.Config.STT. " +
			"The audio turns are auto-transcribed by the swapped provider for the judge.",
		Agents: []scenario.AgentAdapter{
			openairealtime.New(openairealtime.Options{
				Voice:        "alloy",
				Instructions: "You are a helpful assistant. Keep responses brief.",
			}),
			voiceUser("openai/nova", ""),
			judge(
				"The agent responded helpfully across both turns",
				"The conversation is a coherent multi-turn voice exchange",
			),
		},
		Script: []scenario.ScriptStep{
			scenario.User("Hello, can you help me with a quick question?"),
			scenario.Agent(),
			scenario.User("Thanks — and what time zone are you in?"),
			scenario.Agent(),
			scenario.Judge(),
		},
		MaxTurns: 6,
	}, voice.WithConfig(voice.Config{STT: counted}))

	saveRecording(t, voiceResult(t, res).Recording, "composable_stt_swap")
	if calls.Load() == 0 {
		t.Fatal("the swapped STT never ran: the judge fell back to the default")
	}
	t.Logf("ElevenLabs STT calls: %d", calls.Load())
	requireSuccess(t, res)
}
