package twilio

import (
	"context"
	"testing"

	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/internal/mediastream"
)

type discardConn struct{}

func (discardConn) ReadFrame(context.Context) ([]byte, bool, error) { select {} }
func (discardConn) WriteText(context.Context, []byte) error         { return nil }
func (discardConn) Close()                                          {}

// BenchmarkInboundFrame is one 20 ms inbound media frame through the media
// loop: parse, base64-decode into the reused buffer, coalesce. Every fifth
// frame completes a 100 ms batch, which is decoded into a chunk the queue
// owns (the one allocation, 0.2 per frame) and passed through the speech
// gate.
func BenchmarkInboundFrame(b *testing.B) {
	a, _ := New(Options{PhoneNumber: "+14155551234"})
	s := &streamSession{a: a, conn: discardConn{}, adopted: true, buffered: make([]byte, 0, 2*mediastream.BatchBytes)}
	frame := []byte(mediaFrame("MZ18ad3ab5a668481ce02b83e7395059f0", speechFrame[:mediastream.FrameBytes]))
	b.ReportAllocs()
	i := 0
	for b.Loop() {
		f, ok := s.parser.Parse(frame)
		if !ok {
			b.Fatal("parse")
		}
		s.handle(f)
		if i++; i%64 == 0 {
			a.queue.Clear()
		}
	}
}

// BenchmarkSendAudioFrame is one 20 ms outbound frame through SendAudio
// (pacing off): PCM16 24 kHz to µ-law 8 kHz to a JSON media frame.
func BenchmarkSendAudioFrame(b *testing.B) {
	a, _ := New(Options{PhoneNumber: "+14155551234"})
	a.sender.Interval = 0
	a.connected, a.streamConn, a.streamSID = true, discardConn{}, "MZ18ad3ab5a668481ce02b83e7395059f0"
	chunk := voice.AudioChunk{Data: make([]byte, 960)}
	ctx := context.Background()
	b.ReportAllocs()
	for b.Loop() {
		if err := a.SendAudio(ctx, chunk); err != nil {
			b.Fatal(err)
		}
	}
}
