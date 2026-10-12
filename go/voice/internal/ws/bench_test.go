package ws

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// frameSize is one 20 ms PCM16 24 kHz frame as base64 JSON, roughly what
// every adapter sends and receives fifty times a second.
const frameSize = 1400

// Every benchmark here must report 0 allocs/op; the coder/websocket ones
// are the baseline being replaced.

func BenchmarkMask(b *testing.B) {
	buf := make([]byte, frameSize)
	b.SetBytes(frameSize)
	b.ReportAllocs()
	pos := 0
	for b.Loop() {
		pos = mask(buf, 0xDEADBEEF, pos)
	}
}

// discardStream is a stream that accepts every write.
type discardStream struct{}

func (discardStream) Read([]byte) (int, error)         { return 0, io.EOF }
func (discardStream) Write(p []byte) (int, error)      { return len(p), nil }
func (discardStream) Close() error                     { return nil }
func (discardStream) SetReadDeadline(time.Time) error  { return nil }
func (discardStream) SetWriteDeadline(time.Time) error { return nil }

// BenchmarkWriteClient is the outbound frame path: header, mask key,
// masking copy, one write.
func BenchmarkWriteClient(b *testing.B) {
	c := newConn(discardStream{}, bufio.NewReader(discardStream{}), true, "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	msg := bytes.Repeat([]byte("a"), frameSize)
	b.SetBytes(frameSize)
	b.ReportAllocs()
	for b.Loop() {
		if err := c.Write(ctx, MessageText, msg); err != nil {
			b.Fatal(err)
		}
	}
}

// loopReader serves the same bytes forever.
type loopReader struct {
	data []byte
	off  int
}

func (r *loopReader) Read(p []byte) (int, error) {
	n := copy(p, r.data[r.off:])
	r.off = (r.off + n) % len(r.data)
	return n, nil
}

// BenchmarkReadServer is the inbound frame path of a server: header,
// unmasking, append into the reused buffer.
func BenchmarkReadServer(b *testing.B) {
	key := uint32(0x01020304)
	payload := bytes.Repeat([]byte("a"), frameSize)
	frame := appendHeader(nil, true, opText, frameSize, true, key)
	start := len(frame)
	frame = append(frame, payload...)
	mask(frame[start:], key, 0)
	c := newConn(discardStream{}, bufio.NewReaderSize(&loopReader{data: frame}, readBufferSize), false, "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var buf []byte
	b.SetBytes(frameSize)
	b.ReportAllocs()
	for b.Loop() {
		var err error
		if _, buf, err = c.Read(ctx, buf[:0]); err != nil || len(buf) != frameSize {
			b.Fatal(err)
		}
	}
}

// BenchmarkRoundTrip is one frame client to server and back over loopback
// TCP: the per-frame cost an adapter pays in each direction.
func BenchmarkRoundTrip(b *testing.B) {
	client, server := connPair(b)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	msg := bytes.Repeat([]byte("a"), frameSize)
	var sbuf, cbuf []byte
	b.SetBytes(2 * frameSize)
	b.ReportAllocs()
	for b.Loop() {
		if err := client.Write(ctx, MessageText, msg); err != nil {
			b.Fatal(err)
		}
		var err error
		if _, sbuf, err = server.Read(ctx, sbuf[:0]); err != nil {
			b.Fatal(err)
		}
		if err := server.Write(ctx, MessageText, sbuf); err != nil {
			b.Fatal(err)
		}
		if _, cbuf, err = client.Read(ctx, cbuf[:0]); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkCoderRoundTrip is BenchmarkRoundTrip over coder/websocket, the
// baseline (about 8 allocations per read or write).
func BenchmarkCoderRoundTrip(b *testing.B) {
	accepted := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		accepted <- c
		<-r.Context().Done()
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		b.Fatal(err)
	}
	defer client.CloseNow()
	server := <-accepted
	defer server.CloseNow()
	msg := bytes.Repeat([]byte("a"), frameSize)
	buf := make([]byte, 0, 2*frameSize) // never full, so every Read has room
	read := func(c *websocket.Conn) []byte {
		_, r, err := c.Reader(ctx)
		if err != nil {
			b.Fatal(err)
		}
		buf = buf[:0]
		for {
			n, err := r.Read(buf[len(buf):cap(buf)])
			buf = buf[:len(buf)+n]
			if err == io.EOF {
				return buf
			}
			if err != nil {
				b.Fatal(err)
			}
		}
	}
	b.SetBytes(2 * frameSize)
	b.ReportAllocs()
	for b.Loop() {
		if err := client.Write(ctx, websocket.MessageText, msg); err != nil {
			b.Fatal(err)
		}
		got := read(server)
		if err := server.Write(ctx, websocket.MessageText, got); err != nil {
			b.Fatal(err)
		}
		read(client)
	}
}
