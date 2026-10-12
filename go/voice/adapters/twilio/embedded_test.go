package twilio

// Embedded mode: the adapter over a media-stream connection an embedder
// accepted, with no SDK-owned server, tunnel or REST dialing. Plus the
// convenience mode's Tunnel option.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/tunnel"
	"github.com/langwatch/scenario/go/voice/voicetest"
)

// fakeTwilio is a Twilio media-stream client over a real WebSocket that
// answers every utterance it hears with a short spoken reply.
type fakeTwilio struct {
	c       *websocket.Conn
	heard   atomic.Int64
	replies atomic.Int64
}

func dialFakeTwilio(t *testing.T, url string, start string) *fakeTwilio {
	t.Helper()
	c, _, err := websocket.Dial(context.Background(), url, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.CloseNow() })
	f := &fakeTwilio{c: c}
	if err := c.Write(context.Background(), websocket.MessageText, []byte(start)); err != nil {
		t.Fatal(err)
	}
	go f.serve()
	return f
}

// serve reads the adapter's frames; after each utterance (media frames
// followed by a pause) it speaks 500 ms back.
func (f *fakeTwilio) serve() {
	frames := make(chan string, 64)
	go func() {
		defer close(frames)
		for {
			_, b, err := f.c.Read(context.Background())
			if err != nil {
				return
			}
			frames <- string(b)
		}
	}()
	inUtterance := false
	for {
		select {
		case fr, ok := <-frames:
			if !ok {
				return
			}
			var m struct{ Event string }
			_ = json.Unmarshal([]byte(fr), &m)
			if m.Event == "media" {
				f.heard.Add(1)
				inUtterance = true
			}
		case <-time.After(100 * time.Millisecond):
			if !inUtterance {
				continue
			}
			inUtterance = false
			for range 5 {
				_ = f.c.Write(context.Background(), websocket.MessageText, []byte(mediaFrame("MZemb", speechFrame)))
				time.Sleep(100 * time.Millisecond)
			}
			f.replies.Add(1)
		}
	}
}

// embedServer accepts media-stream WebSockets in its own handler and hands
// each to NewStream, the way a server-side runner would.
func embedServer(t *testing.T, opts StreamOptions) (string, chan *Adapter) {
	t.Helper()
	got := make(chan *Adapter, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		got <- NewStream(ws, opts)
	}))
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http") + "/twilio/stream", got
}

func TestEmbeddedStreamRunsAScenario(t *testing.T) {
	url, adapters := embedServer(t, StreamOptions{})
	twilio := dialFakeTwilio(t, url, start695("MZemb", "CAemb"))
	a := <-adapters
	if a.Capabilities().DTMF {
		t.Fatal("an embedded stream without REST must not advertise DTMF")
	}
	ag := voice.NewAgent(a)
	ag.ResponseTailSilence = 400 * time.Millisecond
	ag.ResponseTimeout = 5 * time.Second
	res, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name: "embedded twilio", Description: "a call over an embedded media stream",
		Agents: []scenario.AgentAdapter{ag, &voicetest.User{Lines: []string{"hello"}}, &voicetest.Judge{Verdict: voicetest.Pass()}},
		Script: []scenario.ScriptStep{scenario.User(), scenario.Agent(), scenario.Judge()},
	}, voice.WithConfig(voice.Config{STT: &voicetest.STT{}}), scenario.WithQuiet())
	if err != nil {
		t.Fatal(err)
	}
	if !res.Success {
		t.Fatalf("run failed: %s", res.Reasoning)
	}
	if twilio.heard.Load() == 0 || twilio.replies.Load() == 0 {
		t.Fatalf("heard %d frames, replied %d times", twilio.heard.Load(), twilio.replies.Load())
	}
	var agentAudio int
	for _, m := range res.Messages {
		if m.Role == scenario.RoleAssistant {
			c, _ := voice.ExtractAudio(m)
			agentAudio += len(c.Data)
		}
	}
	if agentAudio == 0 {
		t.Fatal("the reply never reached the agent message")
	}
	if a.CallSID() != "" || a.IsConnected() {
		t.Fatal("disconnect left state behind")
	}
	// The run disconnected the transport, which closed the socket.
	if _, _, err := twilio.c.Read(context.Background()); err == nil {
		t.Fatal("socket still open")
	}
}

func TestEmbeddedNonceIsEnforced(t *testing.T) {
	url, adapters := embedServer(t, StreamOptions{StreamNonce: "n0nce", CallSID: "CAemb", ConnectTimeout: 300 * time.Millisecond})
	dialFakeTwilio(t, url, startFrame(startOpts{nonce: "wrong", callSID: "CAemb"}))
	a := <-adapters
	err := a.Connect(context.Background())
	if !errors.Is(err, ErrStreamConnectTimeout) {
		t.Fatalf("a wrong nonce connected: %v", err)
	}
	_ = a.Disconnect(context.Background())

	dialFakeTwilio(t, url, startFrame(startOpts{nonce: "n0nce", callSID: "CAemb"}))
	a = <-adapters
	if err := a.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer a.Disconnect(context.Background())
	if a.CallSID() != "CAemb" || !a.IsConnected() {
		t.Fatalf("call %q", a.CallSID())
	}
	if err := a.PlaceCall(context.Background(), CallOptions{To: "+14155557777"}); err == nil || !strings.Contains(err.Error(), "embedded") {
		t.Fatalf("PlaceCall: %v", err)
	}
	if err := a.SendDTMF(context.Background(), "1"); err == nil {
		t.Fatal("DTMF without REST")
	}
}

func TestEmbeddedDTMFOverREST(t *testing.T) {
	rest := newSpyREST()
	url, adapters := embedServer(t, StreamOptions{CallSID: "CAemb", REST: rest})
	dialFakeTwilio(t, url, start695("MZemb", "CAemb"))
	a := <-adapters
	if err := a.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer a.Disconnect(context.Background())
	if !a.Capabilities().DTMF {
		t.Fatal("DTMF not advertised with REST")
	}
	if err := a.SendDTMF(context.Background(), "42"); err != nil {
		t.Fatal(err)
	}
	if got := rest.dtmf(); len(got) != 1 || got[0] != [2]string{"CAemb", "42"} {
		t.Fatalf("dtmf %v", got)
	}
}

// TestAcceptConnOnARawConnection hands a raw TCP connection, upgrade
// request unread, to AcceptConn, then runs NewStream over it: the path of a
// connection transferred from another process.
func TestAcceptConnOnARawConnection(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	got := make(chan *Adapter, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		ws, err := AcceptConn(conn, nil, nil)
		if err != nil {
			t.Errorf("AcceptConn: %v", err)
			return
		}
		got <- NewStream(ws, StreamOptions{})
	}()
	dialFakeTwilio(t, "ws://"+ln.Addr().String()+"/twilio/stream", start695("MZraw", "CAraw"))
	a := <-got
	if err := a.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer a.Disconnect(context.Background())
	if a.CallSID() != "CAraw" {
		t.Fatalf("call %q", a.CallSID())
	}
}

// TestAcceptConnOnAHijackedConnection takes the connection over from an
// http.Server handler that already read the request.
func TestAcceptConnOnAHijackedConnection(t *testing.T) {
	got := make(chan *Adapter, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, brw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		head, _ := brw.Reader.Peek(brw.Reader.Buffered())
		ws, err := AcceptConn(conn, r, head)
		if err != nil {
			t.Errorf("AcceptConn: %v", err)
			return
		}
		got <- NewStream(ws, StreamOptions{})
	}))
	defer srv.Close()
	dialFakeTwilio(t, "ws"+strings.TrimPrefix(srv.URL, "http")+"/x", start695("MZhj", "CAhj"))
	a := <-got
	if err := a.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer a.Disconnect(context.Background())
	if a.CallSID() != "CAhj" {
		t.Fatalf("call %q", a.CallSID())
	}
}

func TestAcceptConnRejectsANonUpgrade(t *testing.T) {
	server, client := net.Pipe()
	defer client.Close()
	errc := make(chan error, 1)
	go func() { _, err := AcceptConn(server, nil, nil); errc <- err }()
	go func() { _, _ = client.Write([]byte("GET / HTTP/1.1\r\nHost: x\r\n\r\n")) }()
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	resp, _ := io.ReadAll(client)
	if !strings.HasPrefix(string(resp), "HTTP/1.1 426") || <-errc == nil {
		t.Fatalf("response %q", resp)
	}
}

// fakeProvider is a tunnel provider recording the port it exposed.
type fakeProvider struct {
	port   atomic.Int64
	closed atomic.Bool
	ready  atomic.Int64
}

type fakeTun struct{ p *fakeProvider }

func (f *fakeProvider) Open(_ context.Context, port int) (tunnel.Tunnel, error) {
	f.port.Store(int64(port))
	return fakeTun{f}, nil
}
func (t fakeTun) URL() string  { return "https://fake-tunnel.trycloudflare.com" }
func (t fakeTun) Close() error { t.p.closed.Store(true); return nil }
func (t fakeTun) WaitUntilEdgeReachable(context.Context) error {
	t.p.ready.Add(1)
	return nil
}

func TestTunnelOptionExposesTheLocalServer(t *testing.T) {
	p := &fakeProvider{}
	rest := newSpyREST()
	a, err := New(Options{PhoneNumber: "+14155551234", Tunnel: p, REST: rest, SkipSignatureValidation: true,
		AllowedCallees: []string{aLegDestination}})
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	base, _ := a.LocalBaseURL()
	if !strings.HasSuffix(base, ":"+strconv.FormatInt(p.port.Load(), 10)) || a.PublicBaseURL() != "https://fake-tunnel.trycloudflare.com" {
		t.Fatalf("local %s public %s port %d", base, a.PublicBaseURL(), p.port.Load())
	}
	if err := dialAndConnect(t, a, placeALeg(a)); err != nil {
		t.Fatal(err)
	}
	if p.ready.Load() != 1 || !strings.Contains(rest.places()[0].TwiML, "wss://fake-tunnel.trycloudflare.com/twilio/") {
		t.Fatalf("readiness %d, TwiML %s", p.ready.Load(), rest.places()[0].TwiML)
	}
	_ = a.Disconnect(context.Background())
	if !p.closed.Load() || a.PublicBaseURL() != "" {
		t.Fatal("the tunnel outlived the connection")
	}
}

// TestAcceptStreamOnARawConnection is TestAcceptConnOnARawConnection
// through AcceptStream, which runs the stream on the SDK's own WebSocket.
func TestAcceptStreamOnARawConnection(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	got := make(chan *Adapter, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		a, err := AcceptStream(conn, nil, nil, StreamOptions{})
		if err != nil {
			t.Errorf("AcceptStream: %v", err)
			return
		}
		got <- a
	}()
	dialFakeTwilio(t, "ws://"+ln.Addr().String()+"/twilio/stream", start695("MZnat", "CAnat"))
	a := <-got
	if err := a.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer a.Disconnect(context.Background())
	if a.CallSID() != "CAnat" {
		t.Fatalf("call %q", a.CallSID())
	}
}

// TestAcceptStreamOnAHijackedConnection keeps the bytes the http.Server
// buffered past the request.
func TestAcceptStreamOnAHijackedConnection(t *testing.T) {
	got := make(chan *Adapter, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, brw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		head, _ := brw.Reader.Peek(brw.Reader.Buffered())
		a, err := AcceptStream(conn, r, head, StreamOptions{})
		if err != nil {
			t.Errorf("AcceptStream: %v", err)
			return
		}
		got <- a
	}))
	defer srv.Close()
	dialFakeTwilio(t, "ws"+strings.TrimPrefix(srv.URL, "http")+"/x", start695("MZnh", "CAnh"))
	a := <-got
	if err := a.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer a.Disconnect(context.Background())
	if a.CallSID() != "CAnh" {
		t.Fatalf("call %q", a.CallSID())
	}
}

func TestAcceptStreamRejectsANonUpgrade(t *testing.T) {
	server, client := net.Pipe()
	defer client.Close()
	errc := make(chan error, 1)
	go func() { _, err := AcceptStream(server, nil, nil, StreamOptions{}); errc <- err }()
	go func() { _, _ = client.Write([]byte("GET / HTTP/1.1\r\nHost: x\r\n\r\n")) }()
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	resp, _ := io.ReadAll(client)
	if !strings.HasPrefix(string(resp), "HTTP/1.1 426") || <-errc == nil {
		t.Fatalf("response %q", resp)
	}
}
