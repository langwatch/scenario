package ws

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"io"
	"slices"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// DefaultReadLimit bounds one message, as in github.com/coder/websocket.
	DefaultReadLimit = 32 << 10
	// MaxMessageSize bounds one message whatever the read limit, also with
	// none set: a peer-announced frame length past it closes the connection
	// with StatusMessageTooBig instead of reaching an allocation.
	MaxMessageSize = 1 << 30
	// readGrowStep is the most a read grows its buffer by before the bytes
	// arrive, so a large announced length costs memory only as its payload
	// is received.
	readGrowStep = 1 << 20
	// writeChunk is the largest write: bigger messages go out in pieces
	// (masked through the write buffer on the client side), so the buffer
	// never grows past it.
	writeChunk = 32 << 10
	// readBufferSize is the bufio.Reader size of a dialled connection.
	readBufferSize = 8 << 10
)

// closeTimeout bounds each half of the close handshake, and every control
// frame write. A variable so tests can shorten it.
var closeTimeout = 5 * time.Second

// Conn is a WebSocket connection. One goroutine may read while others
// write: Read calls are serialized among themselves, as are Write calls.
type Conn struct {
	s      stream
	br     *bufio.Reader
	client bool
	proto  string

	readLimit atomic.Int64

	readMu  sync.Mutex
	rw      watch
	readErr error
	// readDone is closed once reading has ended for good (the peer's close
	// frame, an error, or this side closing).
	readDone chan struct{}
	ctrl     [maxControlPayload]byte

	writeMu  sync.Mutex
	ww       watch
	writeErr error
	wbuf     []byte
	// keys holds random mask keys, refilled in bulk.
	keys    [256]byte
	keysPos int

	stateMu   sync.Mutex
	closeSent bool
	closed    bool
	// userClosed is set by Close and CloseNow: failures after it are
	// reported as ErrClosed.
	userClosed bool
}

func newConn(s stream, br *bufio.Reader, client bool, proto string) *Conn {
	c := &Conn{s: s, br: br, client: client, proto: proto, readDone: make(chan struct{})}
	c.readLimit.Store(DefaultReadLimit)
	_, timers := s.(*timerStream)
	c.rw.init(s.SetReadDeadline, timers)
	c.ww.init(s.SetWriteDeadline, timers)
	c.keysPos = len(c.keys)
	return c
}

// Subprotocol is the subprotocol the handshake selected ("" for none).
func (c *Conn) Subprotocol() string { return c.proto }

// SetReadLimit sets the largest message Read accepts; a bigger one closes
// the connection with StatusMessageTooBig. n < 0 removes the limit, short
// of MaxMessageSize, which always applies. The default is DefaultReadLimit.
func (c *Conn) SetReadLimit(n int64) { c.readLimit.Store(n) }

// ------------------------------------------------------------------- read

// Read appends the next data message to dst and returns it with its type.
// Ping, pong and close frames arriving before or between the message's
// fragments are handled on the way: a ping is answered, a close frame is
// echoed and ends the connection with a CloseError. Reuse the returned
// slice as the next dst and the steady state allocates nothing.
//
// If ctx ends while Read waits, Read returns ctx's error and the connection
// is closed. After any error, every later Read returns the same error.
func (c *Conn) Read(ctx context.Context, dst []byte) (MessageType, []byte, error) {
	c.readMu.Lock()
	defer c.readMu.Unlock()
	if c.readErr != nil {
		return 0, dst, c.readErr
	}
	dl, err := c.rw.begin(ctx)
	if err != nil {
		return 0, dst, err
	}
	start := len(dst)
	typ, dst, err := c.readMessage(dst)
	fired := c.rw.end()
	if err != nil {
		var ce CloseError
		if !errors.As(err, &ce) {
			err = c.closedOr(opError(ctx, dl, fired, err))
			c.closeNow()
		}
		c.endReadLocked(err)
		return 0, dst[:start], err
	}
	return typ, dst, nil
}

// closedOr reports ErrClosed for an error caused by Close or CloseNow.
func (c *Conn) closedOr(err error) error {
	c.stateMu.Lock()
	closed := c.userClosed
	c.stateMu.Unlock()
	if closed && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
		return ErrClosed
	}
	return err
}

// endReadLocked records the read side's final error. Holds readMu.
func (c *Conn) endReadLocked(err error) {
	if c.readErr == nil {
		c.readErr = err
		close(c.readDone)
	}
}

// readMessage reads frames until a whole data message is in dst.
func (c *Conn) readMessage(dst []byte) (MessageType, []byte, error) {
	var typ MessageType
	inMessage := false
	start := len(dst)
	for {
		h, err := readHeader(c.br)
		if err != nil {
			return 0, dst, c.failIfProtocol(err)
		}
		if h.rsv != 0 {
			return 0, dst, c.fail(protocolError("reserved bits set without a negotiated extension"))
		}
		if h.masked == c.client {
			if c.client {
				return 0, dst, c.fail(protocolError("masked frame from the server"))
			}
			return 0, dst, c.fail(protocolError("unmasked frame from the client"))
		}
		switch h.op {
		case opPing, opPong, opClose:
			if err := c.readControl(h); err != nil {
				return 0, dst, err
			}
			continue
		case opText, opBinary:
			if inMessage {
				return 0, dst, c.fail(protocolError("new data frame inside a fragmented message"))
			}
			inMessage, typ = true, MessageType(h.op)
		case opContinuation:
			if !inMessage {
				return 0, dst, c.fail(protocolError("continuation frame with no message to continue"))
			}
		default:
			return 0, dst, c.fail(protocolError("unknown opcode"))
		}
		// h.length is under 1<<63 (readHeader rejects the top bit) and the
		// message so far under MaxMessageSize, so the sum cannot overflow.
		size := int64(len(dst)-start) + h.length
		if limit := c.readLimit.Load(); limit >= 0 && size > limit {
			return 0, dst, c.fail(&ProtocolError{Code: StatusMessageTooBig, Msg: "message exceeds the read limit"})
		}
		if size > MaxMessageSize {
			return 0, dst, c.fail(&ProtocolError{Code: StatusMessageTooBig, Msg: "message exceeds the maximum message size"})
		}
		frameStart := len(dst)
		for pos, left := 0, int(h.length); left > 0; {
			k := min(left, readGrowStep)
			n := len(dst)
			dst = slices.Grow(dst, k)[:n+k]
			if _, err := io.ReadFull(c.br, dst[n:]); err != nil {
				return 0, dst[:frameStart], err
			}
			if h.masked {
				pos = mask(dst[n:], h.key, pos)
			}
			left -= k
		}
		if h.fin {
			return typ, dst, nil
		}
	}
}

// readControl reads and handles one control frame.
func (c *Conn) readControl(h header) error {
	if !h.fin {
		return c.fail(protocolError("fragmented control frame"))
	}
	if h.length > maxControlPayload {
		return c.fail(protocolError("control frame payload over 125 bytes"))
	}
	p := c.ctrl[:h.length]
	if _, err := io.ReadFull(c.br, p); err != nil {
		return err
	}
	if h.masked {
		mask(p, h.key, 0)
	}
	switch h.op {
	case opPing:
		// Bounded on its own: the write deadline left by the last Write may
		// have expired already, or be none at all.
		return c.writeControlTimeout(opPong, p, closeTimeout)
	case opPong:
		return nil
	}
	ce, err := parseClose(p)
	if err != nil {
		return c.fail(err)
	}
	c.stateMu.Lock()
	echo := !c.closeSent
	c.closeSent = true
	c.stateMu.Unlock()
	if echo {
		// Echo the status code (RFC 6455 5.5.1); the reason stays ours to give.
		var buf [2]byte
		_ = c.writeControlTimeout(opClose, appendClose(buf[:0], ce.Code, ""), closeTimeout)
	}
	// Our close is out and the peer's is in: the handshake is complete.
	c.closeNow()
	return ce
}

// failIfProtocol fails the connection for a protocol error found while
// parsing a header, and passes I/O errors through.
func (c *Conn) failIfProtocol(err error) error {
	var pe *ProtocolError
	if errors.As(err, &pe) {
		return c.fail(err)
	}
	return err
}

// fail closes the connection over a protocol error: a close frame with the
// error's code (best effort), then the connection itself.
func (c *Conn) fail(err error) error {
	code := StatusProtocolError
	var pe *ProtocolError
	if errors.As(err, &pe) {
		code = pe.Code
	}
	c.stateMu.Lock()
	send := !c.closeSent
	c.closeSent = true
	c.stateMu.Unlock()
	if send {
		var buf [maxControlPayload]byte
		_ = c.writeClosing(appendClose(buf[:0], code, pe.messageOr()))
	}
	c.closeNow()
	return err
}

func (e *ProtocolError) messageOr() string {
	if e == nil {
		return ""
	}
	return e.Msg
}

// ------------------------------------------------------------------ write

// Write sends p as one message of type typ. p is not modified (client
// frames are masked while copying into the connection's write buffer), so
// the caller may reuse it at once.
//
// If ctx ends while Write blocks, Write returns ctx's error and the
// connection is closed. After any error, every later Write returns the same
// error.
func (c *Conn) Write(ctx context.Context, typ MessageType, p []byte) error {
	if typ != MessageText && typ != MessageBinary {
		return errors.New("websocket: unknown message type")
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.writeErr != nil {
		return c.writeErr
	}
	c.stateMu.Lock()
	closing := c.closeSent
	c.stateMu.Unlock()
	if closing {
		return ErrClosed
	}
	dl, err := c.ww.begin(ctx)
	if err != nil {
		return err
	}
	err = c.writeFrameLocked(opcode(typ), p)
	fired := c.ww.end()
	if err != nil {
		err = c.closedOr(opError(ctx, dl, fired, err))
		c.writeErr = err
		c.closeNow()
	}
	return err
}

// writeControlTimeout sends one control frame with a write deadline of
// timeout, then restores the deadline Write applied.
func (c *Conn) writeControlTimeout(op opcode, p []byte, timeout time.Duration) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.writeErr != nil {
		return c.writeErr
	}
	_ = c.s.SetWriteDeadline(time.Now().Add(timeout))
	err := c.writeFrameLocked(op, p)
	_ = c.s.SetWriteDeadline(c.ww.applied)
	return err
}

// writeClosing sends a close frame on the way to closing the connection. A
// Write stuck on a peer that stopped reading holds writeMu with no deadline
// of its own; past closeTimeout the connection is closed under it, which
// fails that Write and frees the lock, so closing never waits longer.
func (c *Conn) writeClosing(p []byte) error {
	t := time.AfterFunc(closeTimeout, c.closeNow)
	defer t.Stop()
	return c.writeControlTimeout(opClose, p, closeTimeout)
}

// writeFrameLocked writes p as one final frame. Holds writeMu.
func (c *Conn) writeFrameLocked(op opcode, p []byte) error {
	var key uint32
	if c.client {
		key = c.nextKey()
	}
	first := min(len(p), writeChunk)
	need := maxHeaderSize + first
	if cap(c.wbuf) < need {
		c.wbuf = make([]byte, 0, need)
	}
	b := appendHeader(c.wbuf[:0], true, op, len(p), c.client, key)
	if !c.client {
		if len(p) > writeChunk {
			// Large unmasked payload: header, then the caller's bytes as is.
			if _, err := c.s.Write(b); err != nil {
				return err
			}
			_, err := c.s.Write(p)
			return err
		}
		b = append(b, p...)
		_, err := c.s.Write(b)
		return err
	}
	pos := 0
	h := len(b)
	b = b[:h+first]
	pos = maskCopy(b[h:], p[:first], key, pos)
	if _, err := c.s.Write(b); err != nil {
		return err
	}
	for p = p[first:]; len(p) > 0; {
		n := min(len(p), cap(c.wbuf))
		b = c.wbuf[:n]
		pos = maskCopy(b, p[:n], key, pos)
		if _, err := c.s.Write(b); err != nil {
			return err
		}
		p = p[n:]
	}
	return nil
}

// nextKey returns a fresh random mask key. Keys are drawn from crypto/rand
// 64 at a time into the connection's own buffer. Holds writeMu.
func (c *Conn) nextKey() uint32 {
	if c.keysPos+4 > len(c.keys) {
		_, _ = rand.Read(c.keys[:])
		c.keysPos = 0
	}
	k := binary.LittleEndian.Uint32(c.keys[c.keysPos:])
	c.keysPos += 4
	return k
}

// ------------------------------------------------------------------ close

// Close performs the close handshake: it sends a close frame with code and
// reason, waits up to five seconds for the peer's close frame (read by a
// concurrent Read if one is running, else by Close itself), then closes the
// connection. A second Close, or a Close after the connection failed,
// returns ErrClosed.
func (c *Conn) Close(code StatusCode, reason string) error {
	c.stateMu.Lock()
	c.userClosed = true
	if c.closeSent {
		c.stateMu.Unlock()
		c.closeNow()
		return ErrClosed
	}
	c.closeSent = true
	c.stateMu.Unlock()

	var buf [maxControlPayload]byte
	err := c.writeClosing(appendClose(buf[:0], code, reason))
	if err == nil {
		c.awaitPeerClose()
	}
	c.closeNow()
	return err
}

// awaitPeerClose waits for the peer's close frame. Without a concurrent
// reader it reads (and discards) messages itself until the close arrives.
func (c *Conn) awaitPeerClose() {
	if !c.readMu.TryLock() {
		// A Read is running: it sees the close frame and closes readDone.
		t := time.NewTimer(closeTimeout)
		defer t.Stop()
		select {
		case <-c.readDone:
		case <-t.C:
		}
		return
	}
	defer c.readMu.Unlock()
	if c.readErr != nil {
		return
	}
	_ = c.s.SetReadDeadline(time.Now().Add(closeTimeout))
	var scratch []byte
	for {
		var err error
		_, scratch, err = c.readMessage(scratch[:0])
		if err != nil {
			var ce CloseError
			if !errors.As(err, &ce) {
				err = ErrClosed
			}
			c.endReadLocked(err)
			return
		}
	}
}

// CloseNow closes the connection without a close handshake.
func (c *Conn) CloseNow() error {
	c.stateMu.Lock()
	already := c.closed
	c.closeSent, c.userClosed = true, true
	c.stateMu.Unlock()
	if already {
		return ErrClosed
	}
	c.closeNow()
	return nil
}

// closeNow closes the underlying stream once and drops the context
// registrations.
func (c *Conn) closeNow() {
	c.stateMu.Lock()
	if c.closed {
		c.stateMu.Unlock()
		return
	}
	c.closed, c.closeSent = true, true
	c.stateMu.Unlock()
	_ = c.s.Close()
	c.rw.release()
	c.ww.release()
}
