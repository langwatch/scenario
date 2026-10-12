package fake

import (
	"io"
	"net"
	"net/http"
	"sync/atomic"
	"time"
)

// Sink is an in-process HTTP server that stands in for LangWatch's
// /api/scenario-events: it reads each body, counts it and answers 200 with
// "{}". The JS side runs the same server in its own process.
type Sink struct {
	URL    string
	srv    *http.Server
	events atomic.Int64
	bytes  atomic.Int64
}

// StartSink listens on a free loopback port.
func StartSink() (*Sink, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s := &Sink{URL: "http://" + ln.Addr().String()}
	s.srv = &http.Server{Handler: s, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = s.srv.Serve(ln) }()
	return s, nil
}

// ServeHTTP implements http.Handler.
func (s *Sink) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	n, _ := io.Copy(io.Discard, r.Body)
	s.events.Add(1)
	s.bytes.Add(n)
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte("{}"))
}

// Counts returns the events and body bytes received so far.
func (s *Sink) Counts() (events, bytes int64) { return s.events.Load(), s.bytes.Load() }

// Close stops the server.
func (s *Sink) Close() error { return s.srv.Close() }
