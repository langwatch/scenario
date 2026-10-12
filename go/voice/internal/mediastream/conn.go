package mediastream

import (
	"context"
	"io"
	"sync"

	"github.com/coder/websocket"
)

// Conn is a Media Streams connection: frames in, text frames out.
type Conn interface {
	// ReadFrame returns the next frame and whether it was a binary frame.
	// The bytes are valid until the next call. A closed or failed
	// connection reports io.EOF.
	ReadFrame(ctx context.Context) (data []byte, binary bool, err error)
	// WriteText sends one text frame. It may be called concurrently with
	// ReadFrame and with itself.
	WriteText(ctx context.Context, p []byte) error
	// Close starts a graceful close and returns without waiting for it, so a
	// receive loop can close its own socket.
	Close()
}

// WSConn adapts a *websocket.Conn to [Conn], reusing one read buffer.
type WSConn struct {
	c         *websocket.Conn
	buf       []byte
	closeOnce sync.Once
}

// NewWSConn wraps c. The WSConn owns c from here on.
func NewWSConn(c *websocket.Conn) *WSConn {
	// Twilio frames are small; the default limit (32 KiB) also bounds a
	// hostile peer's frame size.
	return &WSConn{c: c, buf: make([]byte, 0, 1024)}
}

// ReadFrame implements Conn. Every read failure (a close frame, a dropped
// TCP connection, a cancelled ctx) is reported as io.EOF: on a media stream
// they all mean the call is gone.
func (w *WSConn) ReadFrame(ctx context.Context) ([]byte, bool, error) {
	typ, r, err := w.c.Reader(ctx)
	if err != nil {
		return nil, false, io.EOF
	}
	w.buf = w.buf[:0]
	for {
		if len(w.buf) == cap(w.buf) {
			w.buf = append(w.buf, 0)[:len(w.buf)]
		}
		n, err := r.Read(w.buf[len(w.buf):cap(w.buf)])
		w.buf = w.buf[:len(w.buf)+n]
		if err == io.EOF {
			return w.buf, typ == websocket.MessageBinary, nil
		}
		if err != nil {
			return nil, false, io.EOF
		}
	}
}

// WriteText implements Conn.
func (w *WSConn) WriteText(ctx context.Context, p []byte) error {
	return w.c.Write(ctx, websocket.MessageText, p)
}

// Close implements Conn: the close handshake runs in the background.
func (w *WSConn) Close() {
	w.closeOnce.Do(func() {
		go func() { _ = w.c.Close(websocket.StatusNormalClosure, "") }()
	})
}

// CloseNow closes the connection immediately, without a close handshake.
func (w *WSConn) CloseNow() { _ = w.c.CloseNow() }
