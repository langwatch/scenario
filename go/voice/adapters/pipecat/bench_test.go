package pipecat

import (
	"testing"

	"github.com/langwatch/scenario/go/voice/internal/mediastream"
)

// BenchmarkInboundFrame is one 20 ms media frame from the bot: parse,
// base64-decode into the reused buffer, coalesce; every fifth frame decodes
// a 100 ms batch into the chunk the queue owns.
func BenchmarkInboundFrame(b *testing.B) {
	a, _ := New(Options{URL: "ws://bot"})
	a.conn = &mediastream.WSConn{}
	frame := []byte(mulawMedia("MZ18ad3ab5a668481ce02b83e7395059f0", mediastream.FrameBytes, 3000))
	b.ReportAllocs()
	i := 0
	for b.Loop() {
		a.onMessage(frame, false)
		if i++; i%64 == 0 {
			a.queue.Clear()
		}
	}
}
