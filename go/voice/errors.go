package voice

import "fmt"

// PendingTransportError reports a turn issued while the transport is not
// connected: before Connect, or after the transport dropped.
type PendingTransportError struct {
	Adapter string
}

func (e *PendingTransportError) Error() string {
	return fmt.Sprintf("%s: transport implementation is not yet wired up. "+
		"Options: (1) run this scenario as an integration test against a live endpoint, "+
		"(2) implement %s's SendAudio/ReceiveAudio — and re-audit its Capabilities so the matrix "+
		"matches what it can actually do. Claiming StreamingTranscripts without a real transcript "+
		"stream will silently break AfterWords interruption.", e.Adapter, e.Adapter)
}

// ErrUserTurnNoAudio is the fail-closed error raised when a user turn
// produced for a voice agent under test carries no audio.
const ErrUserTurnNoAudio = userTurnNoAudioError("A user turn produced for a VOICE agent under test carried no audio. " +
	"A voice agent only \"hears\" a turn that carries audio (its call() extracts audio from the incoming message); " +
	"a text-only user turn never commits, so the next agent turn has nothing to answer and times out. " +
	"Ensure the user side voices its turn — a voice user simulator (userSimulatorAgent with a voice) TTS's its " +
	"generated text to audio, and a realtime user (OpenAI Realtime, role=USER) speaks it natively. " +
	"This fail-closed check prevents silently degrading the user side to text.")

type userTurnNoAudioError string

func (e userTurnNoAudioError) Error() string { return string(e) }
