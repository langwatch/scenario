package voice

import "fmt"

// Capabilities declares what a voice adapter can and cannot do.
// Capability-gated script steps check it and fail with an
// [UnsupportedCapabilityError] when the adapter lacks what a step needs.
type Capabilities struct {
	// StreamingTranscripts is true when the adapter emits incremental
	// transcripts as the agent speaks. Interrupting after N words needs it.
	StreamingTranscripts bool
	// NativeVAD is true when the adapter reports user start/stop speaking
	// itself. When false the SDK-side detector (package vad) is used.
	NativeVAD bool
	// DTMF is true when the adapter can send DTMF tones (telephony).
	DTMF bool
	// Interruption is true when the adapter can signal an interrupt to the
	// agent (for example Twilio "clear" or OpenAI Realtime
	// "response.cancel"). Without it, interruption falls back to barge-in:
	// audio sent while the agent is speaking.
	Interruption bool
	// InputFormats are the wire formats accepted for outgoing user audio,
	// such as "pcm16/24000" or "mulaw/8000".
	InputFormats []string
	// OutputFormats are the wire formats emitted for agent audio.
	OutputFormats []string
}

// UnsupportedCapabilityError reports a script step that needs a capability
// the adapter does not advertise.
type UnsupportedCapabilityError struct {
	Adapter    string
	Capability string
	// Hint suggests an alternative, such as a capability-free variant of
	// the step.
	Hint string
}

func (e *UnsupportedCapabilityError) Error() string {
	msg := fmt.Sprintf("Adapter '%s' does not support capability '%s'. "+
		"See the adapter capability matrix at https://scenario-docs.langwatch.ai/voice/capability-matrix.",
		e.Adapter, e.Capability)
	if e.Hint != "" {
		msg += " " + e.Hint
	}
	return msg
}
