package openairealtime

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
	"testing"

	"github.com/langwatch/scenario/go/voice/internal/wsconn"
)

// stubConn is a socket whose writes can fail; reads park until it closes.
type stubConn struct {
	writeErr error
	closed   atomic.Int32
	done     chan struct{}
}

func newStubConn(writeErr error) *stubConn {
	return &stubConn{writeErr: writeErr, done: make(chan struct{})}
}

func (c *stubConn) Read(ctx context.Context, dst []byte) (wsconn.MessageType, []byte, error) {
	select {
	case <-c.done:
		return 0, dst, errors.New("closed")
	case <-ctx.Done():
		return 0, dst, ctx.Err()
	}
}
func (c *stubConn) Write(context.Context, wsconn.MessageType, []byte) error { return c.writeErr }
func (c *stubConn) Close(wsconn.StatusCode, string) error                   { return c.CloseNow() }
func (c *stubConn) CloseNow() error {
	if c.closed.Add(1) == 1 {
		close(c.done)
	}
	return nil
}
func (c *stubConn) SetReadLimit(int64) {}

func stubbedTransport(conns ...*stubConn) *Transport {
	tr := New(Options{APIKey: "test-key", NoMint: true, Logger: quiet}).Realtime()
	next := 0
	tr.dial = func(context.Context, string, http.Header) (wsconn.Conn, error) {
		c := conns[next]
		next++
		return c, nil
	}
	return tr
}

func TestConnectTearsDownWhenSessionUpdateFails(t *testing.T) {
	c := newStubConn(errors.New("broken pipe"))
	tr := stubbedTransport(c)
	if err := tr.Connect(context.Background()); err == nil {
		t.Fatal("Connect succeeded without its session.update")
	}
	if tr.IsConnected() || c.closed.Load() == 0 {
		t.Fatalf("connected %v, socket closes %d", tr.IsConnected(), c.closed.Load())
	}
}

func TestSecondConnectClosesThePreviousSocket(t *testing.T) {
	first, second := newStubConn(nil), newStubConn(nil)
	tr := stubbedTransport(first, second)
	for range 2 {
		if err := tr.Connect(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	defer tr.Disconnect(context.Background())
	if first.closed.Load() == 0 || second.closed.Load() != 0 || !tr.IsConnected() {
		t.Fatalf("first closes %d, second closes %d", first.closed.Load(), second.closed.Load())
	}
}
