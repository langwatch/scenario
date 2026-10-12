// Package wsconn is the message socket the voice adapters speak through,
// with two implementations behind it: the allocation-free
// internal/ws (the default) and github.com/coder/websocket (the
// connections callers hand in through the public constructors that take a
// *websocket.Conn, and the fallback).
//
// Swapping every adapter's own dials and accepts back to coder/websocket
// is the one line marked in [useCoder].
package wsconn

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/coder/websocket"
	"github.com/langwatch/scenario/go/voice/internal/ws"
)

// useCoder routes Dial and Accept through github.com/coder/websocket
// instead of internal/ws. This is the one line to flip to swap back.
const useCoder = false

// MessageType is a data message type; the values are those of both
// implementations.
type MessageType = ws.MessageType

// StatusCode is a close status code; the values are those of both
// implementations.
type StatusCode = ws.StatusCode

const (
	// MessageText is a text message.
	MessageText = ws.MessageText
	// MessageBinary is a binary message.
	MessageBinary = ws.MessageBinary
	// StatusNormalClosure is the normal close status.
	StatusNormalClosure = ws.StatusNormalClosure
)

// Conn is a WebSocket connection. One goroutine may Read while others
// Write.
type Conn interface {
	// Read appends the next message to dst and returns it. Reuse the
	// returned slice as the next dst.
	Read(ctx context.Context, dst []byte) (MessageType, []byte, error)
	// Write sends p as one message; p may be reused when Write returns.
	Write(ctx context.Context, typ MessageType, p []byte) error
	// Close runs the close handshake with code and reason.
	Close(code StatusCode, reason string) error
	// CloseNow closes without a handshake.
	CloseNow() error
	// SetReadLimit bounds one inbound message.
	SetReadLimit(n int64)
}

// DialOptions configure Dial.
type DialOptions struct {
	// HTTPClient carries the handshake; nil is http.DefaultClient.
	HTTPClient *http.Client
	// Header holds extra handshake headers.
	Header http.Header
	// Host overrides the Host header.
	Host string
	// Subprotocols are offered to the server.
	Subprotocols []string
}

// Dial opens a client connection.
func Dial(ctx context.Context, url string, o DialOptions) (Conn, error) {
	if useCoder {
		c, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
			HTTPClient: o.HTTPClient, HTTPHeader: o.Header, Host: o.Host, Subprotocols: o.Subprotocols,
		})
		if err != nil {
			return nil, redactDialError(err, url)
		}
		return FromCoder(c), nil
	}
	c, _, err := ws.Dial(ctx, url, &ws.DialOptions{
		HTTPClient: o.HTTPClient, Header: o.Header, Host: o.Host, Subprotocols: o.Subprotocols,
	})
	if err != nil {
		return nil, err
	}
	return c, nil
}

// DialCoderOptions dials with options in coder/websocket's form, as public
// adapter options carry them. Options internal/ws can honour (client,
// headers, host, subprotocols) dial natively; compression or ping/pong
// callbacks fall back to coder/websocket.
func DialCoderOptions(ctx context.Context, url string, o *websocket.DialOptions) (Conn, error) {
	if o == nil {
		return Dial(ctx, url, DialOptions{})
	}
	if o.CompressionMode != websocket.CompressionDisabled || o.OnPingReceived != nil || o.OnPongReceived != nil {
		c, _, err := websocket.Dial(ctx, url, o)
		if err != nil {
			return nil, redactDialError(err, url)
		}
		return FromCoder(c), nil
	}
	return Dial(ctx, url, DialOptions{
		HTTPClient: o.HTTPClient, Header: o.HTTPHeader, Host: o.Host, Subprotocols: o.Subprotocols,
	})
}

// redactDialError hides the query string of url in a coder/websocket dial
// error, which can carry a signed credential (ElevenLabs'
// conversation_signature). coder/websocket formats the message when it wraps,
// so the text is rewritten here; internal/ws redacts its own errors.
func redactDialError(err error, url string) error {
	_, query, ok := strings.Cut(url, "?")
	if !ok || query == "" {
		return err
	}
	return &redactedError{err: err, msg: strings.ReplaceAll(err.Error(), "?"+query, "?[redacted]")}
}

type redactedError struct {
	err error
	msg string
}

func (e *redactedError) Error() string { return e.msg }
func (e *redactedError) Unwrap() error { return e.err }

// AcceptOptions configure Accept.
type AcceptOptions struct {
	// InsecureSkipVerify accepts any Origin.
	InsecureSkipVerify bool
}

// Accept completes a server-side handshake on an HTTP request; w must
// implement http.Hijacker.
func Accept(w http.ResponseWriter, r *http.Request, o AcceptOptions) (Conn, error) {
	if useCoder {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: o.InsecureSkipVerify})
		if err != nil {
			return nil, err
		}
		return FromCoder(c), nil
	}
	c, err := ws.Accept(w, r, &ws.AcceptOptions{InsecureSkipVerify: o.InsecureSkipVerify})
	if err != nil {
		return nil, err
	}
	return c, nil
}

// CloseStatus returns the peer's close code carried by err, from either
// implementation, or -1 when err is not a close.
func CloseStatus(err error) StatusCode {
	if code := ws.CloseStatus(err); code != -1 {
		return code
	}
	return StatusCode(websocket.CloseStatus(err))
}

// IsClosed reports whether err means the connection is gone (closed by
// either side), as opposed to a transport or protocol failure.
func IsClosed(err error) bool {
	return CloseStatus(err) != -1 || errors.Is(err, ws.ErrClosed)
}

var _ Conn = (*ws.Conn)(nil)
