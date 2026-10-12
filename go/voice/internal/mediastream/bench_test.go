package mediastream

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coder/websocket"
	"github.com/langwatch/scenario/go/voice/internal/wsconn"
)

// A real inbound Twilio media frame: 20 ms of µ-law with Twilio's metadata.
var twilioMediaFrame = []byte(`{"event":"media","sequenceNumber":"42","media":{"track":"inbound","chunk":"41","timestamp":"820","payload":"` +
	base64.StdEncoding.EncodeToString(make([]byte, FrameBytes)) + `"},"streamSid":"MZ18ad3ab5a668481ce02b83e7395059f0"}`)

func BenchmarkParseMediaFrame(b *testing.B) {
	var p Parser
	b.ReportAllocs()
	b.SetBytes(int64(len(twilioMediaFrame)))
	for b.Loop() {
		if f, ok := p.Parse(twilioMediaFrame); !ok || len(f.Payload) != FrameBytes {
			b.Fatal("parse failed")
		}
	}
}

func BenchmarkAppendMediaFrame(b *testing.B) {
	mulaw := make([]byte, FrameBytes)
	dst := make([]byte, 0, 512)
	b.ReportAllocs()
	for b.Loop() {
		dst = AppendMediaFrame(dst[:0], "MZ18ad3ab5a668481ce02b83e7395059f0", mulaw)
	}
}

type discard struct{}

func (discard) WriteText(context.Context, []byte) error { return nil }

// BenchmarkSendFrame is the outbound path per 20 ms frame: PCM16 24 kHz to
// µ-law 8 kHz, then the JSON media frame.
func BenchmarkSendFrame(b *testing.B) {
	s := Sender{}
	pcm := make([]byte, 960)
	ctx := context.Background()
	b.ReportAllocs()
	for b.Loop() {
		if err := s.Send(ctx, discard{}, "MZ18ad3ab5a668481ce02b83e7395059f0", pcm); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkWebSocketRoundTrip measures one media frame written by a client
// and read and parsed by the server over coder/websocket.
func BenchmarkWebSocketRoundTrip(b *testing.B) {
	got := make(chan *WSConn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		got <- NewWSConn(c)
		<-r.Context().Done()
	}))
	defer srv.Close()
	ctx := context.Background()
	client, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		b.Fatal(err)
	}
	defer client.CloseNow()
	server := <-got
	defer server.CloseNow()
	cw := NewWSConn(client)
	var p Parser
	b.ReportAllocs()
	for b.Loop() {
		if err := cw.WriteText(ctx, twilioMediaFrame); err != nil {
			b.Fatal(err)
		}
		data, _, err := server.ReadFrame(ctx)
		if err != nil {
			b.Fatal(err)
		}
		if _, ok := p.Parse(data); !ok {
			b.Fatal("parse")
		}
	}
}

// BenchmarkNativeRoundTrip is BenchmarkWebSocketRoundTrip over the SDK's
// own WebSocket, which the adapters now use: it must report 0 allocs/op.
func BenchmarkNativeRoundTrip(b *testing.B) {
	got := make(chan *WSConn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := wsconn.Accept(w, r, wsconn.AcceptOptions{})
		if err != nil {
			return
		}
		got <- NewConn(c)
		<-r.Context().Done()
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client, err := wsconn.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), wsconn.DialOptions{})
	if err != nil {
		b.Fatal(err)
	}
	defer client.CloseNow()
	server := <-got
	defer server.CloseNow()
	cw := NewConn(client)
	var p Parser
	b.ReportAllocs()
	for b.Loop() {
		if err := cw.WriteText(ctx, twilioMediaFrame); err != nil {
			b.Fatal(err)
		}
		data, _, err := server.ReadFrame(ctx)
		if err != nil {
			b.Fatal(err)
		}
		if _, ok := p.Parse(data); !ok {
			b.Fatal("parse")
		}
	}
}
