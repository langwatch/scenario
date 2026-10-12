package mediastream

import (
	"context"
	"time"

	"github.com/langwatch/scenario/go/voice/audio"
)

// FrameInterval is the real-time pace of outbound media frames.
const FrameInterval = FrameMs * time.Millisecond

// TextWriter writes one text frame.
type TextWriter interface {
	WriteText(ctx context.Context, p []byte) error
}

// Sender writes canonical PCM16 24 kHz audio as 20 ms µ-law 8 kHz media
// frames paced at real time. Unpaced, a whole utterance arrives in
// milliseconds and trips the far end's VAD into a clipped-utterance reading.
//
// A Sender owns one ticker for the life of the stream (reset at the start of
// each send, stopped at its end) and reuses its µ-law and frame buffers, so
// steady-state sends do not allocate. It is not safe for concurrent use;
// callers serialize sends so frames of two utterances never interleave.
type Sender struct {
	// Interval paces the frames; 0 sends them back to back.
	Interval time.Duration

	mulaw  []byte
	frame  []byte
	ticker *time.Ticker
}

// Send encodes pcm and writes it frame by frame, waiting one interval after
// each frame (the last included), so the call returns once the utterance has
// played out on the wire.
func (s *Sender) Send(ctx context.Context, w TextWriter, streamSID string, pcm []byte) error {
	s.mulaw = audio.AppendMulaw8k(s.mulaw[:0], pcm)
	if len(s.mulaw) == 0 {
		return nil
	}
	if s.Interval > 0 {
		if s.ticker == nil {
			s.ticker = time.NewTicker(s.Interval)
		} else {
			s.ticker.Reset(s.Interval)
		}
		defer s.ticker.Stop()
	}
	for off := 0; off < len(s.mulaw); off += FrameBytes {
		end := min(off+FrameBytes, len(s.mulaw))
		s.frame = AppendMediaFrame(s.frame[:0], streamSID, s.mulaw[off:end])
		if err := w.WriteText(ctx, s.frame); err != nil {
			return err
		}
		if s.Interval > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-s.ticker.C:
			}
		}
	}
	return nil
}
