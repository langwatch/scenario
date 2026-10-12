package twilio

import (
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/internal/mediastream"
	"go.opentelemetry.io/otel/attribute"
)

// runStreamSession serves one media-stream connection: the media loop,
// then, whichever way it ended, dropping the connection as the transport.
// Only the socket that is the live transport may drop it: anyone who knows
// the public URL can open and close a socket, and must not tear the genuine
// call's transport away.
func (a *Adapter) runStreamSession(conn mediastream.Conn) error {
	done := make(chan struct{})
	a.mu.Lock()
	if a.sessions == nil {
		a.sessions = map[mediastream.Conn]chan struct{}{}
	}
	a.sessions[conn] = done
	ctx := a.sessionCtx
	a.mu.Unlock()
	if ctx == nil {
		ctx = context.Background()
	}
	defer func() {
		a.mu.Lock()
		delete(a.sessions, conn)
		a.mu.Unlock()
		close(done)
	}()
	err := a.mediaStreamLoop(ctx, conn)
	a.mu.Lock()
	if a.streamConn == conn {
		a.streamConn, a.streamSID = nil, ""
	}
	a.mu.Unlock()
	return err
}

// streamSession is the per-connection state of one media loop.
type streamSession struct {
	a      *Adapter
	conn   mediastream.Conn
	parser mediastream.Parser
	// adopted is set once the socket became the transport: on its first
	// start frame, after nonce authentication in a-leg mode.
	adopted bool
	// gen is the call generation the socket adopted under.
	gen int
	// buffered coalesces inbound µ-law into 100 ms batches.
	buffered []byte
	// bgTurn is the turn the background receive span was last emitted for.
	bgTurn uint64
}

// ownsLocked reports whether the socket is the transport of the current call.
func (s *streamSession) ownsLocked() bool { return s.adopted && s.gen == s.a.callGeneration }

type verdict int

const (
	accept verdict = iota
	ignore
	reject
)

// mediaStreamLoop parses frames, queues audio and fires DTMF until the
// stream stops, the socket closes or fails.
//
// Until a socket adopted (its start frame, authenticated in a-leg mode), it
// touches no adapter state: its media, DTMF and stop frames are dropped, so
// a leaked URL cannot inject audio into the live call. A socket adopted
// under an older call generation is closed on its next frame.
func (a *Adapter) mediaStreamLoop(ctx context.Context, conn mediastream.Conn) (err error) {
	s := &streamSession{a: a, conn: conn, buffered: make([]byte, 0, 2*mediastream.BatchBytes)}
	defer func() {
		// Audio still batched when the socket closed or failed without a
		// stop frame is the caller's last words: queue it before the end of
		// the call. A socket that is not the current call's transport
		// queues nothing.
		a.mu.Lock()
		owns := s.ownsLocked()
		a.mu.Unlock()
		if owns {
			s.flush()
		}
		// The end-of-call chunk wakes a consumer blocked in ReceiveAudio;
		// the ended flag serves every later call. A socket that never became
		// the current call's transport ends nothing.
		a.mu.Lock()
		owns = s.ownsLocked()
		if owns {
			// The session that owned the duration cap is over.
			a.cancelMaxDurationLocked()
			a.markStreamEndedLocked()
		}
		a.mu.Unlock()
		if owns {
			a.enqueueInbound(voice.AudioChunk{})
		}
	}()
	for {
		data, binary, err := conn.ReadFrame(ctx)
		if err != nil {
			reason := EndedError
			if errors.Is(err, io.EOF) {
				reason, err = EndedClose, nil
			}
			a.mu.Lock()
			if s.ownsLocked() {
				a.setEndedReasonLocked(reason)
			}
			a.mu.Unlock()
			return err
		}
		if binary {
			// Media Streams is JSON over text frames only.
			continue
		}
		f, ok := s.parser.Parse(data)
		if !ok {
			continue
		}
		if done := s.handle(f); done {
			return nil
		}
	}
}

// handle processes one frame and reports whether the loop must end.
func (s *streamSession) handle(f mediastream.Frame) bool {
	a := s.a
	a.mu.Lock()
	if s.adopted && s.gen != a.callGeneration {
		a.mu.Unlock()
		s.conn.Close()
		return true
	}
	if f.Event != mediastream.EventStart && !s.adopted {
		a.mu.Unlock()
		return false
	}
	switch f.Event {
	case mediastream.EventStart:
		// The nonce is read now, not at loop entry: a socket that opened
		// before an a-leg dial armed it is still gated on it.
		if expected := a.streamNonce; expected != "" {
			switch s.authenticate(f, expected) {
			case reject:
				a.mu.Unlock()
				s.conn.Close()
				return true
			case ignore:
				a.mu.Unlock()
				return false
			}
		}
		if !s.adopted {
			s.adopted, s.gen = true, a.callGeneration
			a.streamConn = s.conn
			a.resetCallStateLocked()
		}
		if len(f.StreamSID) > 0 {
			a.streamSID = string(f.StreamSID)
			a.sawLiveStream = true
		}
		if f.CallSID != "" && a.callSID == "" {
			a.callSID = f.CallSID
		}
		a.streamConnected.fire()
		a.mu.Unlock()
	case mediastream.EventMedia:
		a.framesReceived++
		a.mu.Unlock()
		s.buffered = append(s.buffered, f.Payload...)
		if len(s.buffered) >= mediastream.BatchBytes {
			s.flush()
		}
	case mediastream.EventDTMF:
		a.dtmfReceived++
		a.mu.Unlock()
		a.logger.Debug("twilio: received DTMF", "digit", f.DTMFDigit)
		a.fireDTMF(f.DTMFDigit)
	case mediastream.EventStop:
		a.mu.Unlock()
		s.flush()
		a.mu.Lock()
		if s.ownsLocked() {
			a.setEndedReasonLocked(EndedStop)
		}
		a.mu.Unlock()
		return true
	default:
		a.mu.Unlock()
	}
	return false
}

// authenticate checks an a-leg start frame: the nonce first (constant
// time; a missing parameter is a rejection), then the originated call SID,
// so a stale or probing socket cannot win the race to connect. The nonce is
// never logged: it is a live credential for the rest of the call.
func (s *streamSession) authenticate(f mediastream.Frame, expected string) verdict {
	a := s.a
	if !NonceMatches(expected, f.CustomParameters["nonce"]) {
		a.logger.Warn("twilio: media stream rejected — a-leg nonce missing or mismatched", "callSid", f.CallSID)
		return reject
	}
	originated := a.callSID
	if originated == "" && a.embed != nil {
		// An embedder that names no call SID authenticated the call itself.
		return accept
	}
	if originated == "" || f.CallSID != originated {
		a.logger.Warn("twilio: start frame ignored — callSid is not the originated call",
			"callSid", f.CallSID, "originatedCallSid", originated)
		return ignore
	}
	return accept
}

// flush decodes the buffered µ-law into one canonical chunk and queues it.
// The first delivery under a live turn is wrapped in a voice.audio.receive
// span parented to that turn; later deliveries of the same turn, and audio
// arriving between turns, are not spanned (no per-chunk span flood).
func (s *streamSession) flush() {
	if len(s.buffered) == 0 {
		return
	}
	// The chunk is handed to the queue (and the speech gate's pre-roll), so
	// it owns its buffer.
	pcm := audio.AppendPCM24kFromMulaw8k(make([]byte, 0, 6*len(s.buffered)+2), s.buffered)
	s.buffered = s.buffered[:0]
	chunk := voice.AudioChunk{Data: pcm}
	a := s.a
	a.mu.Lock()
	parent, seq := a.turnCtx, a.turnSeq
	a.mu.Unlock()
	if parent == nil || seq == s.bgTurn {
		a.enqueueInbound(chunk)
		return
	}
	s.bgTurn = seq
	_, span := voice.StartSpan(parent, voice.SpanAudioReceive,
		attribute.String("voice.adapter.class", Name),
		attribute.String("voice.twilio.recv.source", "background_loop"),
		attribute.Int("voice.audio.bytes", len(pcm)))
	a.enqueueInbound(chunk)
	voice.EndSpan(span, nil)
}

// enqueueInbound is the single inbound entry point. With the speech gate on,
// only what it admits (speech, hangover, pre-roll, the end-of-call chunk)
// reaches the queue: the arrival gap during the callee's silence is what
// lets the drain end the turn.
func (a *Adapter) enqueueInbound(c voice.AudioChunk) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.gate == nil {
		a.queue.Put(c)
		return
	}
	a.admitted = a.gate.Admit(a.admitted[:0], c)
	for _, x := range a.admitted {
		a.queue.Put(x)
	}
	clear(a.admitted)
}

// fireDTMF runs the DTMF callback; a panic in it is logged, not propagated.
func (a *Adapter) fireDTMF(digit string) {
	if a.onDTMF == nil {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			a.logger.Warn("twilio: OnDTMF callback panicked; continuing", "error", fmt.Sprint(r))
		}
	}()
	a.onDTMF(digit)
}

// markStreamEndedLocked marks the call ended. A stop or close on a stream
// that went live, which this adapter did not tear down itself, is the far
// end hanging up; the duration cap, errors and never-live streams are not.
func (a *Adapter) markStreamEndedLocked() {
	a.streamEnded = true
	if (a.endedReason == EndedStop || a.endedReason == EndedClose) && a.sawLiveStream && !a.localDisconnect {
		a.agentHungUp = true
	}
}

// resetCallStateLocked re-arms the per-call state when a socket adopts: a
// second session on the same connection must not inherit the previous
// call's ended flag or reason, nor serve its leftover end-of-call chunk as
// the new call's first audio. Buffered chunks are dropped but a consumer
// already waiting keeps waiting for this call's audio.
func (a *Adapter) resetCallStateLocked() {
	a.streamEnded = false
	a.endedReason = EndedNone
	a.queue.Clear()
	if a.gate != nil {
		a.gate.Reset()
	}
}
