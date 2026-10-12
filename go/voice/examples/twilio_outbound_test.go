// Example: Twilio Outbound Call
//
// A real phone call. The adapter dials from one Twilio number
// (TWILIO_PHONE_NUMBER_2, the caller) to another (TWILIO_PHONE_NUMBER, the
// callee); for the length of the call it points the callee's voice URL at
// its own webhook, which attaches a Media Stream to that leg. The voice
// user simulator then talks over the bridged audio (µ-law 8 kHz).
//
// Twilio must reach this machine: set TWILIO_PUBLIC_BASE_URL to an HTTPS
// URL routed to the local server, or install cloudflared and the adapter
// opens a quick tunnel itself.
//
// Mirrors: python/examples/voice/twilio_outbound.py (the JavaScript SDK
// documents the Twilio adapter but ships no runnable example)
package examples

import (
	"os"
	"os/exec"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/adapters/twilio"
	"github.com/langwatch/scenario/go/voice/tunnel"
)

func TestTwilioOutbound(t *testing.T) {
	skipWithoutOpenAI(t)
	skipWithout(t, "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "TWILIO_PHONE_NUMBER_2")

	opts := twilio.Options{
		AccountSID:    os.Getenv("TWILIO_ACCOUNT_SID"),
		AuthToken:     os.Getenv("TWILIO_AUTH_TOKEN"),
		PhoneNumber:   os.Getenv("TWILIO_PHONE_NUMBER_2"), // the caller
		PublicBaseURL: os.Getenv("TWILIO_PUBLIC_BASE_URL"),
	}
	if opts.PublicBaseURL == "" {
		if _, err := exec.LookPath("cloudflared"); err != nil {
			t.Skip("set TWILIO_PUBLIC_BASE_URL or install cloudflared")
		}
		opts.Tunnel = tunnel.Cloudflared{}
	}
	phone, err := twilio.New(opts)
	if err != nil {
		t.Fatal(err)
	}

	// Connect starts the local webhook server (and the tunnel); the call
	// must be live before the first turn. scenario.Run's own Connect is a
	// no-op on a connected adapter, and its Disconnect hangs up.
	if err := phone.Connect(t.Context()); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = phone.Disconnect(t.Context()) }()
	if err := phone.PlaceCall(t.Context(), twilio.CallOptions{
		To:      os.Getenv("TWILIO_PHONE_NUMBER"), // the callee, a number on this account
		Attach:  twilio.AttachBLeg,
		Timeout: 120 * time.Second,
	}); err != nil {
		t.Fatal(err)
	}
	t.Logf("call %s is live", phone.CallSID())

	res := run(t, scenario.ScenarioConfig{
		Name: "twilio_outbound_demo",
		Description: "The adapter dials out from one Twilio number to another. " +
			"The voice user simulator plays the user over Media Streams; the judge " +
			"evaluates that audio was exchanged and the call completed without " +
			"transport errors.",
		Agents: []scenario.AgentAdapter{
			voice.NewAgent(phone),
			voiceUser("openai/nova", ""),
			judge(
				"The agent received audio from the user simulator",
				"The agent and user exchanged audio turns via Media Streams",
				"The call completed without transport errors",
			),
		},
		Script: []scenario.ScriptStep{
			scenario.User("Hello, can you help me?"),
			scenario.Agent(),
			scenario.Judge(),
		},
		MaxTurns: 4,
	})

	saveRecording(t, voiceResult(t, res).Recording, "twilio_outbound")
	requireSuccess(t, res)
}
