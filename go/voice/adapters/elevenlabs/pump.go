package elevenlabs

import (
	"context"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/langwatch/scenario/go/voice"
	"go.opentelemetry.io/otel/trace"
)

const (
	// pumpFrameBytes is one 20 ms PCM16 frame at 24 kHz mono.
	pumpFrameBytes = 960
	// pumpInterval is the microphone cadence: one frame per tick is
	// real-time 24 kHz audio. Bursting a whole turn at once made the server
	// miss the end of the user's turn.
	pumpInterval = 20 * time.Millisecond
)

// pumpStats are the microphone pump's counters, stamped on the disconnect
// span (the pump has no per-tick span).
type pumpStats struct {
	ticks, speech, silence, unexpectedErrors int
}

// runPump feeds one frame per tick until ctx ends.
func (t *Transport) runPump(ctx context.Context, conn *websocket.Conn, done chan struct{}) {
	defer close(done)
	tick := time.NewTicker(pumpInterval)
	defer tick.Stop()
	buf := make([]byte, 0, userAudioChunkLen(pumpFrameBytes))
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		msg, ok := t.nextPumpFrame(buf[:0])
		if !ok {
			continue
		}
		if err := conn.Write(ctx, websocket.MessageText, msg); err != nil {
			t.pumpWriteFailed(ctx, err)
		}
	}
}

// nextPumpFrame encodes this tick's frame into dst: queued speech when the
// user is speaking; nothing once the agent answered and the next user turn
// has not started (the post-response pause, so the inter-turn gap is not
// read as the user having left); otherwise closing silence, the
// audio-to-silence transition the server VAD ends the user's turn on.
func (t *Transport) nextPumpFrame(dst []byte) ([]byte, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.activeLocked() {
		return dst, false
	}
	t.stats.ticks++
	switch {
	case t.outPos < len(t.out):
		frame := t.out[t.outPos : t.outPos+pumpFrameBytes]
		t.outPos += pumpFrameBytes
		t.stats.speech++
		return appendUserAudioChunk(dst, frame), true
	case t.awaitingUserTurn:
		return dst, false
	default:
		t.stats.silence++
		return append(dst, t.silenceMsg...), true
	}
}

// pumpWriteFailed handles a frame the socket refused. A write racing the
// session closing is dropped; any other failure ends the session, as the
// SDK does when sending a user audio chunk fails.
func (t *Transport) pumpWriteFailed(ctx context.Context, err error) {
	t.mu.Lock()
	t.stats.unexpectedErrors++
	active := t.activeLocked() && ctx.Err() == nil
	conn := t.conn
	t.mu.Unlock()
	if !active {
		return
	}
	t.o.Logger.Error("Error sending user audio chunk: " + err.Error())
	conn.CloseNow()
}

// stopPumpLocked stops the pump and drops unsent frames. It also resets
// the turn state so a reconnect starts in the closing-silence phase.
func (t *Transport) stopPumpLocked() {
	if t.cancelPump != nil {
		t.cancelPump()
		t.cancelPump = nil
	}
	t.out, t.outPos = t.out[:0], 0
	t.awaitingUserTurn = false
	t.toolsInFlight = 0
	t.toolTurnOpen = false
}

// queuedFrames is how many speech frames wait for the pump.
func (t *Transport) queuedFrames() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return (len(t.out) - t.outPos) / pumpFrameBytes
}

// SendAudio commits a user turn according to the TurnCommitMode. In the
// default CommitAudio mode the PCM is sliced into 20 ms frames for the
// microphone pump and SendAudio returns at once; the pump paces the frames
// and then streams closing silence until the agent answers. A pending
// conversation id is stamped on the span in ctx.
func (t *Transport) SendAudio(ctx context.Context, chunk voice.AudioChunk) error {
	t.mu.Lock()
	if !t.activeLocked() {
		t.mu.Unlock()
		return ErrNotConnected
	}
	// The conversation id may have arrived after the connect span ended;
	// this span is the first later one the transport is sure to see.
	t.stampConversationIDLocked(trace.SpanFromContext(ctx))
	transcript := strings.TrimSpace(chunk.Transcript)
	if t.o.TurnCommitMode == CommitText && transcript != "" {
		t.beginUserTurnLocked()
		t.mu.Unlock()
		return t.SendUserMessage(ctx, transcript)
	}
	if len(chunk.Data) > 0 {
		t.beginUserTurnLocked()
		t.audioCommits++
		t.enqueueLocked(chunk.Data)
		if t.o.TurnCommitMode != CommitAudio {
			t.enqueueLocked(make([]byte, t.o.SilenceTailBytes))
		}
	}
	t.mu.Unlock()
	return nil
}

// beginUserTurnLocked lifts the post-response pause and clears the previous
// agent turn's tool and audio state.
func (t *Transport) beginUserTurnLocked() {
	t.awaitingUserTurn = false
	t.toolsInFlight = 0
	t.toolTurnOpen = false
	t.lastAgentAudioAt = time.Time{}
}

// enqueueLocked appends pcm to the outbound queue as whole frames, padding
// the last one with zeros. The queue owns a copy, so the caller may reuse
// pcm.
func (t *Transport) enqueueLocked(pcm []byte) {
	if t.outPos > 0 {
		n := copy(t.out, t.out[t.outPos:])
		t.out, t.outPos = t.out[:n], 0
	}
	t.out = append(t.out, pcm...)
	if pad := (pumpFrameBytes - len(pcm)%pumpFrameBytes) % pumpFrameBytes; pad > 0 {
		t.out = append(t.out, make([]byte, pad)...)
	}
}
