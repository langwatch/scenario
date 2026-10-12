package ws

import (
	"bufio"
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"
)

// tcpPair returns the two ends of a loopback TCP connection. TCP (unlike
// net.Pipe) buffers, so a test can send a sequence of frames before the
// connection under test reads them, and that connection's replies (pongs,
// close echoes) do not block.
func tcpPair(t testing.TB) (net.Conn, net.Conn) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			close(accepted)
			return
		}
		accepted <- c
	}()
	a, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	b, ok := <-accepted
	if !ok {
		t.Fatal("accept failed")
	}
	t.Cleanup(func() { _ = a.Close(); _ = b.Close() })
	return a, b
}

// connPair returns a client and a server Conn talking to each other.
func connPair(t testing.TB) (client, server *Conn) {
	a, b := tcpPair(t)
	client = newConn(a, bufio.NewReader(a), true, "")
	server = newConn(b, bufio.NewReader(b), false, "")
	return client, server
}

// rawPeer drives the far end of a Conn frame by frame. A peer facing a
// server Conn plays the client and masks its frames.
type rawPeer struct {
	t     testing.TB
	nc    net.Conn
	br    *bufio.Reader
	masks bool
}

// serverUnderTest returns a server Conn and the raw client peer facing it.
func serverUnderTest(t testing.TB) (*Conn, *rawPeer) {
	a, b := tcpPair(t)
	return newConn(b, bufio.NewReader(b), false, ""), &rawPeer{t: t, nc: a, br: bufio.NewReader(a), masks: true}
}

// clientUnderTest returns a client Conn and the raw server peer facing it.
func clientUnderTest(t testing.TB) (*Conn, *rawPeer) {
	a, b := tcpPair(t)
	return newConn(a, bufio.NewReader(a), true, ""), &rawPeer{t: t, nc: b, br: bufio.NewReader(b)}
}

// frame sends one frame with the peer's default masking.
func (p *rawPeer) frame(fin bool, op opcode, payload []byte) {
	p.t.Helper()
	p.frameWith(fin, 0, op, payload, p.masks)
}

// frameWith sends one frame with explicit reserved bits and masking.
func (p *rawPeer) frameWith(fin bool, rsv byte, op opcode, payload []byte, masked bool) {
	p.t.Helper()
	key := uint32(0x37FA213D)
	b := appendHeader(nil, fin, op, len(payload), masked, key)
	b[0] |= rsv
	start := len(b)
	b = append(b, payload...)
	if masked {
		mask(b[start:], key, 0)
	}
	if _, err := p.nc.Write(b); err != nil {
		p.t.Fatalf("peer write: %v", err)
	}
}

// closeFrame sends a close frame with code and reason.
func (p *rawPeer) closeFrame(code int, reason string) {
	p.t.Helper()
	p.frame(true, opClose, append(binary.BigEndian.AppendUint16(nil, uint16(code)), reason...))
}

// recv reads one frame from the Conn under test.
func (p *rawPeer) recv() (header, []byte) {
	p.t.Helper()
	_ = p.nc.SetReadDeadline(time.Now().Add(5 * time.Second))
	h, err := readHeader(p.br)
	if err != nil {
		p.t.Fatalf("peer read header: %v", err)
	}
	b := make([]byte, h.length)
	if _, err := io.ReadFull(p.br, b); err != nil {
		p.t.Fatalf("peer read payload: %v", err)
	}
	if h.masked {
		mask(b, h.key, 0)
	}
	if h.masked == p.masks {
		p.t.Fatalf("frame masked=%v from the conn under test, peer masks=%v", h.masked, p.masks)
	}
	return h, b
}

// expectClose reads the close frame the Conn under test sent and checks
// its code (StatusNoStatusRcvd: an empty payload).
func (p *rawPeer) expectClose(code StatusCode) {
	p.t.Helper()
	h, b := p.recv()
	if h.op != opClose {
		p.t.Fatalf("got opcode %x, want a close frame", h.op)
	}
	got := StatusNoStatusRcvd
	if len(b) >= 2 {
		got = StatusCode(binary.BigEndian.Uint16(b))
	}
	if got != code {
		p.t.Fatalf("close code %d (%q), want %d", got, b, code)
	}
}

// expectEOF checks that the Conn under test closed the TCP connection.
func (p *rawPeer) expectEOF() {
	p.t.Helper()
	_ = p.nc.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := p.br.ReadByte(); err == nil {
		p.t.Fatal("connection still open")
	}
}
