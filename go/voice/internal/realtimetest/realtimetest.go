// Package realtimetest is an in-process WebSocket server standing in for a
// realtime voice endpoint (OpenAI Realtime, Gemini Live) in adapter tests.
// It records every frame the client sends and pushes server events to the
// connected client.
package realtimetest

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Frame is one frame the client sent.
type Frame struct {
	// Type is the frame's "type" field, empty when it has none.
	Type string
	Raw  []byte
	Data map[string]any
}

// Server is the mock endpoint. Create it with New.
type Server struct {
	// URL is the ws:// address of the server.
	URL string

	srv *httptest.Server

	mu      sync.Mutex
	conn    *websocket.Conn
	ready   chan struct{}
	frames  []Frame
	headers []http.Header
	paths   []string
}

// New starts a server closed when the test ends.
func New(t testing.TB) *Server {
	s := &Server{ready: make(chan struct{})}
	s.srv = httptest.NewServer(http.HandlerFunc(s.handle))
	s.URL = "ws" + strings.TrimPrefix(s.srv.URL, "http")
	t.Cleanup(func() {
		s.mu.Lock()
		if s.conn != nil {
			_ = s.conn.CloseNow()
		}
		s.mu.Unlock()
		s.srv.Close()
	})
	return s
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	c.SetReadLimit(-1)
	s.mu.Lock()
	s.conn = c
	s.headers = append(s.headers, r.Header.Clone())
	s.paths = append(s.paths, r.URL.RequestURI())
	select {
	case <-s.ready:
	default:
		close(s.ready)
	}
	s.mu.Unlock()
	for {
		_, b, err := c.Read(context.Background())
		if err != nil {
			return
		}
		f := Frame{Raw: b}
		if json.Unmarshal(b, &f.Data) == nil {
			f.Type, _ = f.Data["type"].(string)
		}
		s.mu.Lock()
		if s.conn == c {
			s.frames = append(s.frames, f)
		}
		s.mu.Unlock()
	}
}

// Arm drops the current client connection and the recorded frames, ready
// for the next connection.
func (s *Server) Arm() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn != nil {
		_ = s.conn.CloseNow()
		s.conn = nil
	}
	s.frames = nil
	s.ready = make(chan struct{})
}

// WaitConnected waits for a client to connect after the last Arm.
func (s *Server) WaitConnected(t testing.TB) {
	t.Helper()
	s.mu.Lock()
	ready := s.ready
	s.mu.Unlock()
	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("realtimetest: no client connected")
	}
}

// Push sends payload, JSON-encoded, to the client as a text frame.
func (s *Server) Push(t testing.TB, payload any) { s.push(t, websocket.MessageText, payload) }

// PushBinary sends payload, JSON-encoded, as a binary frame (Gemini Live
// delivers its server messages that way).
func (s *Server) PushBinary(t testing.TB, payload any) { s.push(t, websocket.MessageBinary, payload) }

// PushRaw sends b verbatim as a text frame.
func (s *Server) PushRaw(t testing.TB, b []byte) {
	t.Helper()
	s.write(t, websocket.MessageText, b)
}

func (s *Server) push(t testing.TB, typ websocket.MessageType, payload any) {
	t.Helper()
	b, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("realtimetest: %v", err)
	}
	s.write(t, typ, b)
}

func (s *Server) write(t testing.TB, typ websocket.MessageType, b []byte) {
	t.Helper()
	s.mu.Lock()
	c := s.conn
	s.mu.Unlock()
	if c == nil {
		t.Fatal("realtimetest: socket not connected")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.Write(ctx, typ, b); err != nil {
		t.Fatalf("realtimetest: push: %v", err)
	}
}

// Close closes the client connection from the server side.
func (s *Server) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn != nil {
		_ = s.conn.Close(websocket.StatusNormalClosure, "")
	}
}

// Frames returns the frames recorded since the last Arm.
func (s *Server) Frames() []Frame {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Frame(nil), s.frames...)
}

// Types returns the types of the recorded frames, in order.
func (s *Server) Types() []string {
	fs := s.Frames()
	out := make([]string, len(fs))
	for i, f := range fs {
		out[i] = f.Type
	}
	return out
}

// OfType returns the recorded frames of a type.
func (s *Server) OfType(typ string) []Frame {
	var out []Frame
	for _, f := range s.Frames() {
		if f.Type == typ {
			out = append(out, f)
		}
	}
	return out
}

// Headers returns the request headers of every connection, in order.
func (s *Server) Headers() []http.Header {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]http.Header(nil), s.headers...)
}

// Paths returns the request URIs of every connection, in order.
func (s *Server) Paths() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.paths...)
}

// WaitFor polls the recorded frames until pred holds.
func (s *Server) WaitFor(t testing.TB, pred func([]Frame) bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !pred(s.Frames()) {
		if time.Now().After(deadline) {
			t.Fatalf("realtimetest: timed out waiting; frames: %v", s.Types())
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// WaitType waits for a frame of type typ recorded at index since or later.
func (s *Server) WaitType(t testing.TB, typ string, since int) {
	t.Helper()
	s.WaitFor(t, func(fs []Frame) bool {
		for i := since; i < len(fs); i++ {
			if fs[i].Type == typ {
				return true
			}
		}
		return false
	})
}

// Len is the number of recorded frames.
func (s *Server) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.frames)
}
