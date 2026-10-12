package voice

import (
	"context"
	"errors"
	"reflect"
	"time"
)

// Transport is the wire to a voice agent: it opens a session, carries user
// audio to the agent and agent audio back. Audio crossing it is always
// canonical PCM16 (24 kHz, mono); the transport converts to and from its
// wire format at the edge.
//
// A Transport is wrapped by [NewAgent], which runs the turn logic (send,
// drain on tail silence, record, report). Optional behaviour is declared by
// implementing the interfaces below; the agent type-asserts each one.
type Transport interface {
	// Connect opens the transport. It is called once, before the first
	// script step.
	Connect(ctx context.Context) error
	// Disconnect closes the transport. It is called once on every exit path;
	// its error is swallowed so cleanup never masks the scenario result.
	Disconnect(ctx context.Context) error
	// SendAudio transmits user audio to the agent.
	SendAudio(ctx context.Context, chunk AudioChunk) error
	// ReceiveAudio returns the next chunk of agent audio, waiting at most
	// timeout. An empty chunk signals the end of the agent's turn; a timeout
	// is reported as an error (wrapping [ErrReceiveTimeout] by convention).
	ReceiveAudio(ctx context.Context, timeout time.Duration) (AudioChunk, error)
	// Capabilities declares what the transport can do.
	Capabilities() Capabilities
}

// ErrReceiveTimeout is the conventional error a transport wraps when
// ReceiveAudio saw no audio within its timeout.
var ErrReceiveTimeout = errors.New("voice: no agent audio within the receive timeout")

// Named is implemented by transports that report a name in spans, warnings
// and errors (the JavaScript SDK's adapter class name, such as
// "ElevenLabsAgentAdapter"). Without it the Go type name is used.
type Named interface {
	Name() string
}

// ConnectionReporter is implemented by transports with a real "not
// connected" state. A turn issued while it reports false fails with a
// [PendingTransportError] (or concludes quietly when the agent hung up).
// Transports without it count as always connected.
type ConnectionReporter interface {
	IsConnected() bool
}

// HangupReporter is implemented by transports that can tell the agent ended
// the call on purpose (for example an ElevenLabs agent invoking end_call),
// as opposed to the transport dropping. A turn after a hangup concludes the
// conversation instead of failing the run.
type HangupReporter interface {
	AgentHungUp() bool
}

// DTMFSender is implemented by telephony transports advertising
// Capabilities.DTMF.
type DTMFSender interface {
	SendDTMF(ctx context.Context, tones string) error
}

// Interrupter is implemented by transports advertising
// Capabilities.Interruption: it sends the transport-native interrupt signal
// (Twilio "clear", OpenAI Realtime "response.cancel").
type Interrupter interface {
	Interrupt(ctx context.Context) error
}

// StreamingTranscriber is implemented by transports advertising
// Capabilities.StreamingTranscripts: the incremental transcript of the
// agent's current utterance, read by Interrupt(AfterWords(n)).
type StreamingTranscriber interface {
	StreamingTranscript() string
}

// TranscriptSource is implemented by transports that deliver the agent
// turn's text separately from its audio (ElevenLabs agent_response, Gemini
// and OpenAI Realtime transcript events). The agent resets it when a user
// turn is sent, waits a bounded grace period for it after the audio drained,
// and attaches it to the agent message.
type TranscriptSource interface {
	// LastAgentTranscript returns the current turn's transcript; empty while
	// it is pending.
	LastAgentTranscript() string
	// ResetAgentTranscript clears it at the start of an agent turn that
	// replies to user audio.
	ResetAgentTranscript()
}

// PendingAudioReconciler is implemented by buffering transports that may
// strand agent audio of a previous turn in their queue. It is drained at the
// next user-turn boundary; the audio is attributed to the previous agent
// segment when that is safe, else dropped, so it never bleeds out as the
// fake start of the next agent turn.
type PendingAudioReconciler interface {
	ReconcilePendingAudio() (AudioChunk, bool)
}

// TurnObserver is implemented by transports with a background receive loop
// (Pipecat, Twilio) that start spans from detached callbacks: BeginTurn hands
// them the context of the live voice.turn span so those spans parent under
// the turn; EndTurn marks the turn closed.
type TurnObserver interface {
	BeginTurn(ctx context.Context)
	EndTurn()
}

// RealtimeUser is implemented by user-role agents that speak scripted lines
// natively (OpenAI Realtime as the user): the model synthesizes the voice,
// no TTS is involved.
type RealtimeUser interface {
	SpeakUserTurn(ctx context.Context, text string) (AudioChunk, error)
}

// transportName is the name a transport reports.
func transportName(t any) string {
	if n, ok := t.(Named); ok {
		if name := n.Name(); name != "" {
			return name
		}
	}
	rt := reflect.TypeOf(t)
	for rt != nil && rt.Kind() == reflect.Pointer {
		rt = rt.Elem()
	}
	if rt == nil || rt.Name() == "" {
		return "VoiceAgentAdapter"
	}
	return rt.Name()
}
