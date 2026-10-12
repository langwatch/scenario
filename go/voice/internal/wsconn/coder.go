package wsconn

import (
	"context"
	"io"

	"github.com/coder/websocket"
)

// coderConn adapts a *websocket.Conn to Conn.
type coderConn struct{ c *websocket.Conn }

// FromCoder wraps a github.com/coder/websocket connection, for the public
// constructors that take one. Its reads and writes allocate as
// coder/websocket does (a context.AfterFunc per call).
func FromCoder(c *websocket.Conn) Conn { return coderConn{c} }

func (w coderConn) Read(ctx context.Context, dst []byte) (MessageType, []byte, error) {
	typ, r, err := w.c.Reader(ctx)
	if err != nil {
		return 0, dst, err
	}
	start := len(dst)
	for {
		if len(dst) == cap(dst) {
			dst = append(dst, 0)[:len(dst)]
		}
		n, err := r.Read(dst[len(dst):cap(dst)])
		dst = dst[:len(dst)+n]
		if err == io.EOF {
			return MessageType(typ), dst, nil
		}
		if err != nil {
			return 0, dst[:start], err
		}
	}
}

func (w coderConn) Write(ctx context.Context, typ MessageType, p []byte) error {
	return w.c.Write(ctx, websocket.MessageType(typ), p)
}

func (w coderConn) Close(code StatusCode, reason string) error {
	return w.c.Close(websocket.StatusCode(code), reason)
}

func (w coderConn) CloseNow() error { return w.c.CloseNow() }

func (w coderConn) SetReadLimit(n int64) { w.c.SetReadLimit(n) }
