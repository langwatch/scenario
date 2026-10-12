package ws

import (
	"io"
	"net"
	"sync"
	"time"
)

// stream is the byte stream under a Conn: a net.Conn, or the body of a
// 101 response plus the net.Conn it runs on.
type stream interface {
	io.ReadWriteCloser
	SetReadDeadline(time.Time) error
	SetWriteDeadline(time.Time) error
}

// bodyStream reads and writes the switched-protocol response body (which
// first drains bytes the HTTP transport buffered past the response) and
// takes deadlines from the connection it runs on. Deadlines on the TCP
// connection under a TLS one apply to the TLS reads and writes too.
type bodyStream struct {
	io.ReadWriteCloser
	nc net.Conn
}

func (s bodyStream) SetReadDeadline(t time.Time) error  { return s.nc.SetReadDeadline(t) }
func (s bodyStream) SetWriteDeadline(t time.Time) error { return s.nc.SetWriteDeadline(t) }

// timerStream gives deadlines to a stream with no net.Conn underneath (an
// http.RoundTripper that is not an *http.Transport): an expired deadline
// closes the stream, which fails the blocked call. Every context that ends
// during an operation closes the connection anyway, so the only difference
// from a real deadline is that a deadline cannot be lifted once it expired.
// Each direction owns one timer, reset in place, so this allocates once.
type timerStream struct {
	io.ReadWriteCloser
	read, write deadlineTimer
}

func newTimerStream(rwc io.ReadWriteCloser) *timerStream {
	s := &timerStream{ReadWriteCloser: rwc}
	s.read.close = s.closeNow
	s.write.close = s.closeNow
	return s
}

func (s *timerStream) closeNow()                          { _ = s.ReadWriteCloser.Close() }
func (s *timerStream) SetReadDeadline(t time.Time) error  { s.read.set(t); return nil }
func (s *timerStream) SetWriteDeadline(t time.Time) error { s.write.set(t); return nil }

type deadlineTimer struct {
	mu    sync.Mutex
	t     *time.Timer
	close func()
}

func (d *deadlineTimer) set(at time.Time) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if at.IsZero() {
		if d.t != nil {
			d.t.Stop()
		}
		return
	}
	wait := time.Until(at)
	if d.t == nil {
		d.t = time.AfterFunc(wait, d.close)
		return
	}
	d.t.Reset(wait)
}
