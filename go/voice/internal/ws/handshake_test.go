package ws

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// echoServer accepts with o and echoes every message until the peer
// closes. The last upgrade request's headers are kept.
type echoServer struct {
	*httptest.Server
	mu     sync.Mutex
	header http.Header
}

func newEchoServer(t *testing.T, o *AcceptOptions) *echoServer {
	s := &echoServer{}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.header = r.Header.Clone()
		s.mu.Unlock()
		c, err := Accept(w, r, o)
		if err != nil {
			return
		}
		echo(c)
	}))
	t.Cleanup(s.Close)
	return s
}

func echo(c *Conn) {
	var buf []byte
	for {
		typ, msg, err := c.Read(context.Background(), buf[:0])
		if err != nil {
			return
		}
		buf = msg
		if err := c.Write(context.Background(), typ, msg); err != nil {
			return
		}
	}
}

func wsURL(s *httptest.Server) string { return "ws" + strings.TrimPrefix(s.URL, "http") }

func roundTrip(t *testing.T, c *Conn, msg string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.Write(ctx, MessageText, []byte(msg)); err != nil {
		t.Fatal(err)
	}
	typ, got, err := c.Read(ctx, nil)
	if err != nil || typ != MessageText || string(got) != msg {
		t.Fatalf("echo: %d %q %v", typ, got, err)
	}
}

func TestDialAndAccept(t *testing.T) {
	s := newEchoServer(t, &AcceptOptions{Subprotocols: []string{"b", "a"}})
	c, resp, err := Dial(context.Background(), wsURL(s.Server), &DialOptions{
		Header:       http.Header{"Authorization": {"Bearer k"}},
		Subprotocols: []string{"a", "b"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if c.Subprotocol() != "b" {
		t.Fatalf("subprotocol %q, want the server's preference", c.Subprotocol())
	}
	s.mu.Lock()
	auth := s.header.Get("Authorization")
	ext := s.header.Get("Sec-WebSocket-Extensions")
	s.mu.Unlock()
	if auth != "Bearer k" {
		t.Fatalf("Authorization %q", auth)
	}
	if ext != "" {
		t.Fatalf("dial offered extensions %q", ext)
	}
	roundTrip(t, c, "hello")
	if err := c.Close(StatusNormalClosure, ""); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func TestDialAcceptsHTTPSchemes(t *testing.T) {
	s := newEchoServer(t, nil)
	c, _, err := Dial(context.Background(), s.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	roundTrip(t, c, "http scheme")
}

func TestDialOverTLS(t *testing.T) {
	s := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := Accept(w, r, nil)
		if err == nil {
			echo(c)
		}
	}))
	defer s.Close()
	c, _, err := Dial(context.Background(), "wss"+strings.TrimPrefix(s.URL, "https"), &DialOptions{HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if _, ok := c.s.(bodyStream); !ok {
		t.Fatalf("stream %T: the dialled connection was not captured", c.s)
	}
	roundTrip(t, c, "over TLS")
	// A context deadline works on the captured connection.
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, _, err := c.Read(ctx, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestDialThroughACustomRoundTripper(t *testing.T) {
	s := newEchoServer(t, nil)
	var used bool
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		used = true
		return http.DefaultTransport.RoundTrip(r)
	})}
	c, _, err := Dial(context.Background(), wsURL(s.Server), &DialOptions{HTTPClient: client})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if !used {
		t.Fatal("the client's transport was not used")
	}
	if _, ok := c.s.(*timerStream); !ok {
		t.Fatalf("stream %T, want the timer fallback", c.s)
	}
	roundTrip(t, c, "custom transport")
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, _, err := c.Read(ctx, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
}

// connectProxy is a minimal HTTP CONNECT proxy counting its tunnels.
func connectProxy(t *testing.T) (*httptest.Server, *atomic.Int32) {
	var tunnels atomic.Int32
	p := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			http.Error(w, "CONNECT only", http.StatusMethodNotAllowed)
			return
		}
		up, err := net.Dial("tcp", r.Host)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		tunnels.Add(1)
		down, brw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			_ = up.Close()
			return
		}
		_, _ = down.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
		go func() { _, _ = io.Copy(up, brw); _ = up.Close() }()
		_, _ = io.Copy(down, up)
		_ = down.Close()
	}))
	t.Cleanup(p.Close)
	return p, &tunnels
}

func TestDialThroughAProxy(t *testing.T) {
	s := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := Accept(w, r, nil)
		if err == nil {
			echo(c)
		}
	}))
	defer s.Close()
	proxy, tunnels := connectProxy(t)
	tr := s.Client().Transport.(*http.Transport).Clone()
	proxyURL, _ := url.Parse(proxy.URL)
	// http.ProxyFromEnvironment caches the environment once per process, so
	// the proxy is set explicitly; the path through the transport is the
	// one an HTTPS_PROXY setting takes.
	tr.Proxy = http.ProxyURL(proxyURL)
	c, _, err := Dial(context.Background(), "wss"+strings.TrimPrefix(s.URL, "https"), &DialOptions{HTTPClient: &http.Client{Transport: tr}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	roundTrip(t, c, "through the proxy")
	if n := tunnels.Load(); n != 1 {
		t.Fatalf("%d tunnels", n)
	}
}

func TestDialFollowsRedirectsToWS(t *testing.T) {
	s := newEchoServer(t, nil)
	r := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		http.Redirect(w, req, wsURL(s.Server)+"/moved", http.StatusTemporaryRedirect)
	}))
	defer r.Close()
	c, _, err := Dial(context.Background(), wsURL(r), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	roundTrip(t, c, "redirected")
}

func TestDialRejectsANonUpgradeResponse(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "no sockets here", http.StatusNotFound)
	}))
	defer s.Close()
	_, resp, err := Dial(context.Background(), wsURL(s), nil)
	if err == nil {
		t.Fatal("dial succeeded")
	}
	if resp == nil || resp.StatusCode != http.StatusNotFound {
		t.Fatalf("resp = %v", resp)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "no sockets here") {
		t.Fatalf("body %q", body)
	}
}

func TestDialRejectsAWrongAcceptKey(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nc, brw, _ := w.(http.Hijacker).Hijack()
		defer nc.Close()
		_, _ = brw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: bogus\r\n\r\n")
		_ = brw.Flush()
	}))
	defer s.Close()
	if _, _, err := Dial(context.Background(), wsURL(s), nil); err == nil || !strings.Contains(err.Error(), "Sec-WebSocket-Accept") {
		t.Fatalf("err = %v", err)
	}
}

func TestDialRejectsAnUnofferedExtension(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nc, brw, _ := w.(http.Hijacker).Hijack()
		defer nc.Close()
		_, _ = brw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
			acceptKey(r.Header.Get("Sec-WebSocket-Key")) + "\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n")
		_ = brw.Flush()
	}))
	defer s.Close()
	if _, _, err := Dial(context.Background(), wsURL(s), nil); err == nil || !strings.Contains(err.Error(), "extension") {
		t.Fatalf("err = %v", err)
	}
}

func TestDialHonoursTheContext(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close() // accepts nothing: the handshake hangs
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, _, err := Dial(ctx, "ws://"+ln.Addr().String(), nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
}

func upgradeRequest(s *httptest.Server, mutate func(*http.Request)) (*http.Response, error) {
	req, _ := http.NewRequest(http.MethodGet, s.URL, nil)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	mutate(req)
	return http.DefaultClient.Do(req)
}

func TestAcceptRejectsBadRequests(t *testing.T) {
	s := newEchoServer(t, nil)
	cases := []struct {
		name   string
		mutate func(*http.Request)
		status int
	}{
		{"version", func(r *http.Request) { r.Header.Set("Sec-WebSocket-Version", "8") }, http.StatusBadRequest},
		{"no key", func(r *http.Request) { r.Header.Del("Sec-WebSocket-Key") }, http.StatusBadRequest},
		{"short key", func(r *http.Request) { r.Header.Set("Sec-WebSocket-Key", "c2hvcnQ=") }, http.StatusBadRequest},
		{"no upgrade", func(r *http.Request) { r.Header.Del("Upgrade") }, http.StatusUpgradeRequired},
		{"method", func(r *http.Request) { r.Method = http.MethodPost }, http.StatusMethodNotAllowed},
		{"origin", func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") }, http.StatusForbidden},
	}
	for _, c := range cases {
		resp, err := upgradeRequest(s.Server, c.mutate)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != c.status {
			t.Fatalf("%s: status %d, want %d", c.name, resp.StatusCode, c.status)
		}
		if c.name == "version" && resp.Header.Get("Sec-WebSocket-Version") != "13" {
			t.Fatal("426/400 for a version must name the supported one")
		}
	}
}

func TestAcceptSkipsTheOriginCheckWhenAsked(t *testing.T) {
	s := newEchoServer(t, &AcceptOptions{InsecureSkipVerify: true})
	resp, err := upgradeRequest(s.Server, func(r *http.Request) { r.Header.Set("Origin", "https://elsewhere.example") })
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestAcceptConnKeepsAPipelinedFrame(t *testing.T) {
	a, b := tcpPair(t)
	// The client writes its upgrade request and, without waiting, its first
	// frame: both land in the server's reader in one go.
	raw := "GET /stream HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
		"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
	key := uint32(0x11223344)
	frame := appendHeader(nil, true, opText, 5, true, key)
	payload := []byte("first")
	mask(payload, key, 0)
	frame = append(frame, payload...)
	if _, err := a.Write(append([]byte(raw), frame...)); err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(b)
	req, err := http.ReadRequest(br)
	if err != nil {
		t.Fatal(err)
	}
	c, err := AcceptConn(b, br, req, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, msg := readOK(t, c); string(msg) != "first" {
		t.Fatalf("got %q", msg)
	}
	resp, err := http.ReadResponse(bufio.NewReader(a), req)
	if err != nil || resp.StatusCode != http.StatusSwitchingProtocols ||
		resp.Header.Get("Sec-WebSocket-Accept") != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Fatalf("resp = %v, %v", resp, err)
	}
}

func TestAcceptConnAnswersABadRequest(t *testing.T) {
	a, b := tcpPair(t)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	if _, err := AcceptConn(b, nil, req, nil); err == nil {
		t.Fatal("accepted a plain GET")
	}
	resp, err := http.ReadResponse(bufio.NewReader(a), req)
	if err != nil || resp.StatusCode != http.StatusUpgradeRequired {
		t.Fatalf("resp = %v, %v", resp, err)
	}
}

// -- interoperability with github.com/coder/websocket

func TestInteropClientToCoderServer(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		c.SetReadLimit(-1)
		for {
			typ, msg, err := c.Read(r.Context())
			if err != nil {
				return
			}
			if err := c.Write(r.Context(), typ, msg); err != nil {
				return
			}
		}
	}))
	defer s.Close()
	c, _, err := Dial(context.Background(), wsURL(s), nil)
	if err != nil {
		t.Fatal(err)
	}
	c.SetReadLimit(-1)
	roundTrip(t, c, "to coder")
	big := strings.Repeat("0123456789", 20000) // 200 KB: chunked, masked writes
	roundTrip(t, c, big)
	if err := c.Close(StatusNormalClosure, "bye"); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func TestInteropCoderClientToServer(t *testing.T) {
	s := newEchoServer(t, nil)
	ctx := context.Background()
	c, _, err := websocket.Dial(ctx, wsURL(s.Server), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if err := c.Write(ctx, websocket.MessageBinary, []byte("from coder")); err != nil {
		t.Fatal(err)
	}
	typ, msg, err := c.Read(ctx)
	if err != nil || typ != websocket.MessageBinary || string(msg) != "from coder" {
		t.Fatalf("%v %q %v", typ, msg, err)
	}
	if err := c.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatalf("coder Close against our server: %v", err)
	}
}
