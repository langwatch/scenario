package openairealtime

import (
	"context"
	"time"

	"github.com/langwatch/scenario/go/voice"
	"go.opentelemetry.io/otel/trace"
)

// DefaultUserTurnTailTimeout is the per-frame idle timeout that ends a
// spoken user turn.
const DefaultUserTurnTailTimeout = 15 * time.Second

// maxSpokenFrames bounds one spoken user turn so a misbehaving stream cannot
// loop forever: far beyond a one-sentence line at tens of ms per frame.
const maxSpokenFrames = 400

const (
	verbatimInstructions = "You are voicing ONE line spoken by a customer in a support call. " +
		"Say the line below OUT LOUD, in the first person, EXACTLY as written. " +
		"Do NOT answer it, do NOT respond to it, do NOT add or change any " +
		"words — just speak this line and nothing else: "
	generatedInstructions = "You are the CUSTOMER on a support call — never the agent. Listen " +
		"to what the agent just said, then say your NEXT line: one short, " +
		"natural, first-person sentence that moves your own request forward " +
		"(ask your next question, or answer what the agent just asked). Stay " +
		"in character as the customer; do NOT answer as the agent, do NOT " +
		"repeat or echo the agent's words, do NOT offer to help. Speak only " +
		"your next line."
)

// SpeakUserTurn voices a scripted user line and drains the audio the model
// synthesizes for it (voice.RealtimeUser): one out-of-band response.create
// told to SPEAK the line as the customer, not answer it, then the spoken
// deltas merged into one chunk. Its transcript is the model's own spoken
// transcript, else text.
//
// The line is intent, not exact: the model may rephrase it. Use a text or
// TTS user for word-for-word lines.
//
// The scripted path opens no span and adds no markers to the caller's.
func (t *Transport) SpeakUserTurn(ctx context.Context, text string) (voice.AudioChunk, error) {
	t.resetSpokenTranscript()
	if err := t.speakVerbatim(ctx, text); err != nil {
		return voice.AudioChunk{}, err
	}
	return t.drainSpokenTurn(trace.ContextWithSpan(ctx, trace.SpanFromContext(context.Background())), text), nil
}

// speakGeneratedTurn speaks the next customer line generatively, in context
// (the committed heard audio and the conversation so far condition it), and
// drains it. With no transcript on the wire the chunk carries none: audio
// presence, not transcript presence, is the contract.
func (t *Transport) speakGeneratedTurn(ctx context.Context) (voice.AudioChunk, error) {
	t.resetSpokenTranscript()
	if err := t.requestGeneratedTurn(ctx); err != nil {
		return voice.AudioChunk{}, err
	}
	return t.drainSpokenTurn(ctx, ""), nil
}

// resetSpokenTranscript clears both per-turn transcript fields, so a turn
// whose transcript never lands cannot return the previous turn's line.
func (t *Transport) resetSpokenTranscript() {
	t.mu.Lock()
	t.lastAgentTranscript, t.agentTranscriptBuf = "", ""
	t.mu.Unlock()
}

// persona prefixes per-response instructions with the session persona: a
// per-response instructions field overrides the session's.
func (t *Transport) persona() string {
	if t.instructions == "" {
		return ""
	}
	return t.instructions + "\n\n"
}

// speakVerbatim sends the isolated render of one line: conversation "none"
// and input [] keep earlier renders out of context (so the model does not
// start answering by turn three), audio output forced.
//
// Like requestGeneratedTurn it is deliberately not guarded by the
// response-active deferral: the deferred re-fire is a bare response.create
// that would drop these fields, and user turns are single-flight (each is
// drained before the next).
func (t *Transport) speakVerbatim(ctx context.Context, text string) error {
	if _, _, err := t.current(); err != nil {
		return err
	}
	return t.writeJSON(ctx, map[string]any{
		"type": "response.create",
		"response": map[string]any{
			"conversation":      "none",
			"input":             []any{},
			"output_modalities": []string{"audio"},
			"instructions":      t.persona() + verbatimInstructions + text,
		},
	})
}

// requestGeneratedTurn commits the heard audio, so the drain does not fire
// a second bare response.create and the next turn starts from an empty
// buffer, then sends one in-context response.create.
func (t *Transport) requestGeneratedTurn(ctx context.Context) error {
	if _, _, err := t.current(); err != nil {
		return err
	}
	t.mu.Lock()
	pending := t.pendingAudioBytes > 0
	t.pendingAudioBytes = 0
	t.mu.Unlock()
	if pending {
		if err := t.write(ctx, frameCommit); err != nil {
			return err
		}
	}
	return t.writeJSON(ctx, map[string]any{
		"type": "response.create",
		"response": map[string]any{
			"output_modalities": []string{"audio"},
			"instructions":      t.persona() + generatedInstructions,
		},
	})
}

// drainSpokenTurn receives one spoken turn until its deltas stop (a
// per-frame idle timeout, a closed socket or an error event) or an empty
// chunk arrives, and merges the PCM16.
func (t *Transport) drainSpokenTurn(ctx context.Context, fallbackTranscript string) voice.AudioChunk {
	tail := t.UserTurnTailTimeout
	if tail <= 0 {
		tail = DefaultUserTurnTailTimeout
	}
	var merged []byte
	for range maxSpokenFrames {
		c, err := t.ReceiveAudio(ctx, tail)
		if err != nil || len(c.Data) == 0 {
			break
		}
		merged = append(merged, c.Data...)
	}
	transcript := t.LastAgentTranscript()
	if transcript == "" {
		transcript = fallbackTranscript
	}
	return voice.AudioChunk{Data: merged, Transcript: transcript}
}
