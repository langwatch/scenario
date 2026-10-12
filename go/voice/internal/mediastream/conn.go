package mediastream

import (
	"context"
	"io"
	"sync"

	"github.com/coder/websocket"
	"github.com/langwatch/scenario/go/voice/internal/wsconn"
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

// WSConn adapts a WebSocket to [Conn], reusing one read buffer.
type WSConn struct {
	c         wsconn.Conn
	buf       []byte
	closeOnce sync.Once
}

// NewWSConn wraps a coder/websocket connection, as the public constructors
// that take one hand it over. The WSConn owns c from here on.
func NewWSConn(c *websocket.Conn) *WSConn { return NewConn(wsconn.FromCoder(c)) }

// NewConn wraps c. The WSConn owns c from here on.
func NewConn(c wsconn.Conn) *WSConn {
	// Twilio frames are small; a 32 KiB limit (both implementations'
	// default) also bounds a hostile peer's frame size.
	c.SetReadLimit(32 << 10)
	return &WSConn{c: c, buf: make([]byte, 0, 1024)}
}

// ReadFrame implements Conn. Every read failure (a close frame, a dropped
// TCP connection, a cancelled ctx) is reported as io.EOF: on a media stream
// they all mean the call is gone.
func (w *WSConn) ReadFrame(ctx context.Context) ([]byte, bool, error) {
	typ, buf, err := w.c.Read(ctx, w.buf[:0])
	w.buf = buf
	if err != nil {
		return nil, false, io.EOF
	}
	return buf, typ == wsconn.MessageBinary, nil
}

// WriteText implements Conn.
func (w *WSConn) WriteText(ctx context.Context, p []byte) error {
	return w.c.Write(ctx, wsconn.MessageText, p)
}

// Close implements Conn: the close handshake runs in the background.
func (w *WSConn) Close() {
	w.closeOnce.Do(func() {
		go func() { _ = w.c.Close(wsconn.StatusNormalClosure, "") }()
	})
}

// CloseNow closes the connection immediately, without a close handshake.
func (w *WSConn) CloseNow() { _ = w.c.CloseNow() }
