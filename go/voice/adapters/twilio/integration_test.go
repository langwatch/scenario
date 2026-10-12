//go:build integration

package twilio

// Live a-leg external-number smoke, ported from
// twilio-a-leg-external.e2e.test.ts (AC11). It dials a real external number
// over a real cloudflared quick tunnel and runs a scenario over the media
// stream attached to our own leg. It bills a PSTN call, so it runs only when
// the operator opted in and named the destination:
//
//	SCENARIO_LIVE_TWILIO=1 TWILIO_ACCOUNT_SID=… TWILIO_AUTH_TOKEN=… \
//	TWILIO_PHONE_NUMBER=+1… SCENARIO_TWILIO_EXTERNAL_TO=+1… \
//	go test -tags integration -run ALegExternal ./adapters/twilio
//
// The user line is spoken with OpenAI TTS when OPENAI_API_KEY is set
// (voice SCENARIO_TWILIO_E2E_VOICE, default openai/nova), else as a test
// tone. Unlike the JavaScript twin there is no LLM judge (the voice module
// has no LLM provider): the evidence is the inbound frame count and the
// callee's audio on the agent turn.

import (
	"context"
	"os"
	"os/exec"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/tts"
	"github.com/langwatch/scenario/go/voice/tunnel"
	"github.com/langwatch/scenario/go/voice/voicetest"
)

const outboundPrompt = "Hello, I am calling to test this line. Can you hear me?"

// speakingUser voices one scripted line over TTS, or a tone without a key.
type speakingUser struct{ voiceName string }

func (u speakingUser) Role() scenario.AgentRole { return scenario.AgentRoleUser }

func (u speakingUser) Call(ctx context.Context, _ scenario.AgentInput) (*scenario.AgentReturn, error) {
	c := voicetest.Tone(2, outboundPrompt)
	if os.Getenv("OPENAI_API_KEY") != "" {
		var err error
		if c, err = tts.Synthesize(ctx, outboundPrompt, u.voiceName); err != nil {
			return nil, err
		}
		c.Transcript = outboundPrompt
	}
	return scenario.MessageReturn(voice.AudioMessage(c, scenario.RoleUser)), nil
}

func TestALegExternalLive(t *testing.T) {
	if os.Getenv("SCENARIO_LIVE_TWILIO") != "1" {
		t.Skip("missing env: SCENARIO_LIVE_TWILIO=1 (bills a real PSTN call, opt-in only)")
	}
	for _, k := range []string{"TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "SCENARIO_TWILIO_EXTERNAL_TO"} {
		if os.Getenv(k) == "" {
			t.Skipf("set %s (and the other TWILIO_* vars) to dial a live a-leg call", k)
		}
	}
	if _, err := exec.LookPath("cloudflared"); err != nil {
		t.Skip("cloudflared not installed")
	}
	to := os.Getenv("SCENARIO_TWILIO_EXTERNAL_TO")
	voiceName := os.Getenv("SCENARIO_TWILIO_E2E_VOICE")
	if voiceName == "" {
		voiceName = "openai/nova"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	a, err := New(Options{
		AccountSID:  os.Getenv("TWILIO_ACCOUNT_SID"),
		AuthToken:   os.Getenv("TWILIO_AUTH_TOKEN"),
		PhoneNumber: os.Getenv("TWILIO_PHONE_NUMBER"),
		// The harness's tunnel answers "is our public URL live yet?".
		Tunnel: tunnel.Cloudflared{},
		// Deny-by-default: the operator's destination is the only one.
		AllowedCallees:          []string{to},
		SkipSignatureValidation: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	defer a.Disconnect(context.Background())
	if err := a.PlaceCall(ctx, CallOptions{To: to, Attach: AttachALeg, Timeout: 2 * time.Minute, MaxCallDuration: 45 * time.Second}); err != nil {
		t.Fatal(err)
	}

	framesSeen := 0
	ag := voice.NewAgent(a)
	res, err := scenario.Run(ctx, scenario.ScenarioConfig{
		Name:        "twilio_a_leg_external_smoke",
		Description: "The adapter dials an external number and attaches the media stream to its own leg.",
		Agents:      []scenario.AgentAdapter{ag, speakingUser{voiceName}, &voicetest.Judge{Verdict: voicetest.Pass()}},
		Script: []scenario.ScriptStep{scenario.User(), scenario.Agent(),
			// Sampled inside the run: the run's disconnect zeroes the counters.
			scenario.StepFunc(func(context.Context, *scenario.Executor) error {
				framesSeen = state(a, func(a *Adapter) int { return a.framesReceived })
				return nil
			}),
			scenario.Judge()},
		MaxTurns: 4,
	}, voice.WithConfig(voice.Config{STT: &voicetest.STT{}}))
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("a-leg e2e: frames_received=%d", framesSeen)
	if framesSeen == 0 {
		t.Fatal("no inbound media frames decoded: the a-leg socket carried no audio")
	}
	replied := false
	for _, m := range res.Messages {
		if c, ok := voice.ExtractAudio(m); ok && m.Role == scenario.RoleAssistant && len(c.Data) > 0 {
			replied = true
		}
	}
	if !replied {
		t.Fatal("no reply from the callee captured on the stream")
	}
}
