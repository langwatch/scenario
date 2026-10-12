package twilio

// Ported from twilio-stream-path-nonce.test.ts and
// twilio-external-upgrade.test.ts: the real upgrade route with the nonce in
// the path, and the split-process handoff of a raw, unhandshaked socket.

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"net"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestStreamWSURL(t *testing.T) {
	for _, c := range [][3]string{
		{"https://example.test", "abc123", "wss://example.test/twilio/abc123"},
		{"https://example.test", "", "wss://example.test/twilio/stream"},
		{"http://example.test/", "n1", "ws://example.test/twilio/n1"},
	} {
		if got := StreamWSURL(c[0], c[1]); got != c[2] {
			t.Errorf("StreamWSURL(%q, %q) = %q, want %q", c[0], c[1], got, c[2])
		}
	}
}

func TestUpgradeAcceptsTheCorrectPathNonce(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	nonce, call := startALegCall(t, a, rest)
	client, err := dialStream(t, a, "/twilio/"+nonce)
	if err != nil {
		t.Fatalf("upgrade with the correct path nonce was refused: %v", err)
	}
	client.send(startFrame(startOpts{nonce: nonce}))
	if err := await(t, call); err != nil {
		t.Fatal(err)
	}
	if streamConnOf(a) == nil {
		t.Fatal("no transport")
	}
}

func TestUpgradeRefusesAWrongPathNonce(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	_, call := startALegCall(t, a, rest)
	if _, err := dialStream(t, a, "/twilio/not-the-nonce"); err == nil {
		t.Fatal("upgrade with a wrong path nonce was accepted")
	}
	if streamConnOf(a) != nil || !isPending(call) {
		t.Fatal("a refused socket connected")
	}
}

func TestUpgradeStillAcceptsTheLegacyStreamPath(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	nonce, call := startALegCall(t, a, rest)
	client, err := dialStream(t, a, "/twilio/stream")
	if err != nil {
		t.Fatalf("legacy /twilio/stream upgrade was refused: %v", err)
	}
	client.send(startFrame(startOpts{nonce: nonce}))
	if err := await(t, call); err != nil {
		t.Fatal(err)
	}
}

func TestUpgradeRefusesDisagreeingPathAndFrameNonces(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	nonce, call := startALegCall(t, a, rest)
	client, err := dialStream(t, a, "/twilio/"+nonce)
	if err != nil {
		t.Fatal(err)
	}
	client.send(startFrame(startOpts{nonce: "a-different-nonce-than-the-path"}))
	if _, err := client.read(3 * time.Second); err == nil {
		t.Fatal("the socket stayed open")
	}
	if streamConnOf(a) != nil || !isPending(call) {
		t.Fatal("stream-connected fired for a disagreeing nonce pair")
	}
}

// maskedTextFrame encodes one client-to-server text frame (masked, as RFC
// 6455 requires of clients), in the short or 16-bit length form.
func maskedTextFrame(payload string) []byte {
	p := []byte(payload)
	var mask [4]byte
	_, _ = rand.Read(mask[:])
	var b bytes.Buffer
	b.WriteByte(0x81)
	if len(p) < 126 {
		b.WriteByte(0x80 | byte(len(p)))
	} else {
		b.WriteByte(0x80 | 126)
		_ = binary.Write(&b, binary.BigEndian, uint16(len(p)))
	}
	b.Write(mask[:])
	for i, c := range p {
		b.WriteByte(c ^ mask[i%4])
	}
	return b.Bytes()
}

func upgradeHead(path string, port int) []byte {
	key := make([]byte, 16)
	_, _ = rand.Read(key)
	return []byte("GET " + path + " HTTP/1.1\r\nHost: 127.0.0.1:" + strconv.Itoa(port) + "\r\nConnection: Upgrade\r\n" +
		"Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " +
		base64.StdEncoding.EncodeToString(key) + "\r\n\r\n")
}

// A "parent" listener on another port reads the upgrade request plus a
// pipelined start frame, then hands the raw socket to the adapter without
// completing the handshake. The call connecting proves the pipelined head
// bytes were replayed ahead of the rest of the stream.
func TestExternalUpgradeHandoffCompletesTheHandshake(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	nonce, call := startALegCall(t, a, rest)

	parent, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer parent.Close()
	headLen := make(chan int, 1)
	go func() {
		conn, err := parent.Accept()
		if err != nil {
			return
		}
		br := bufio.NewReader(conn)
		req, err := http.ReadRequest(br)
		if err != nil {
			conn.Close()
			return
		}
		// Everything read past the request is the head the parent forwards.
		head, _ := br.Peek(br.Buffered())
		headLen <- len(head)
		a.AcceptExternalUpgrade(conn, req, bytes.Clone(head))
	}()

	raw, err := net.Dial("tcp", parent.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	port := parent.Addr().(*net.TCPAddr).Port
	pipelined := append(upgradeHead("/twilio/"+nonce, port), maskedTextFrame(startFrame(startOpts{nonce: nonce}))...)
	if _, err := raw.Write(pipelined); err != nil {
		t.Fatal(err)
	}
	if n := <-headLen; n == 0 {
		t.Fatal("the test did not force a pipelined head")
	}
	if err := await(t, call); err != nil {
		t.Fatal(err)
	}
	_ = raw.SetReadDeadline(time.Now().Add(2 * time.Second))
	line, err := bufio.NewReader(raw).ReadString('\n')
	if err != nil || !strings.HasPrefix(line, "HTTP/1.1 101") {
		t.Fatalf("response %q, %v", line, err)
	}
}

func TestExternalUpgradeWithoutAServerClosesTheSocket(t *testing.T) {
	a := makeAdapter(t, newSpyREST())
	server, client := net.Pipe()
	defer client.Close()
	a.AcceptExternalUpgrade(server, nil, nil)
	_ = client.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := client.Read(make([]byte, 1)); err == nil {
		t.Fatal("socket left open")
	}
}

func TestExternalUpgradeRefusesAWrongPathNonce(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	_, call := startALegCall(t, a, rest)
	server, client := net.Pipe()
	defer client.Close()
	a.AcceptExternalUpgrade(server, nil, nil)
	go func() { _, _ = client.Write(upgradeHead("/twilio/wrong", 1)) }()
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	line, _ := bufio.NewReader(client).ReadString('\n')
	if !strings.HasPrefix(line, "HTTP/1.1 403") || !isPending(call) {
		t.Fatalf("response %q", line)
	}
}
