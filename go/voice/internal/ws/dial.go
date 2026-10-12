package ws

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

// DialOptions configure Dial. The zero value dials with
// http.DefaultClient.
type DialOptions struct {
	// HTTPClient carries the handshake request: its Transport supplies TLS
	// configuration, the proxy (http.DefaultTransport reads HTTP_PROXY,
	// HTTPS_PROXY and NO_PROXY from the environment) and dialing, so a dial
	// behaves like any HTTP request made with the same client. A Timeout
	// bounds the handshake only.
	HTTPClient *http.Client
	// Header holds extra handshake request headers (authorization, ...).
	Header http.Header
	// Host overrides the Host header.
	Host string
	// Subprotocols are offered in Sec-WebSocket-Protocol, in order.
	Subprotocols []string
}

// Dial opens a client connection to a ws://, wss://, http:// or https://
// URL. On a failed handshake the response, if one arrived, is returned
// with up to 1 KiB of its body readable.
func Dial(ctx context.Context, rawURL string, o *DialOptions) (*Conn, *http.Response, error) {
	if o == nil {
		o = &DialOptions{}
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, nil, fmt.Errorf("websocket: dial: %w", err)
	}
	switch u.Scheme {
	case "ws":
		u.Scheme = "http"
	case "wss":
		u.Scheme = "https"
	case "http", "https":
	default:
		return nil, nil, fmt.Errorf("websocket: dial: unsupported URL scheme %q", u.Scheme)
	}

	var keyBytes [16]byte
	if _, err := rand.Read(keyBytes[:]); err != nil {
		return nil, nil, fmt.Errorf("websocket: dial: %w", err)
	}
	key := base64.StdEncoding.EncodeToString(keyBytes[:])

	client, capture := handshakeClient(o.HTTPClient)
	if client.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, client.Timeout)
		defer cancel()
		client.Timeout = 0
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, nil, fmt.Errorf("websocket: dial: %w", err)
	}
	if o.Host != "" {
		req.Host = o.Host
	}
	req.Header = o.Header.Clone()
	if req.Header == nil {
		req.Header = http.Header{}
	}
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", key)
	if len(o.Subprotocols) > 0 {
		req.Header.Set("Sec-WebSocket-Protocol", strings.Join(o.Subprotocols, ","))
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("websocket: dial: %w", err)
	}
	if err := verifyServerResponse(resp, key, o.Subprotocols); err != nil {
		keepBodyHead(resp)
		return nil, resp, fmt.Errorf("websocket: dial: %w", err)
	}
	rwc, ok := resp.Body.(io.ReadWriteCloser)
	if !ok {
		keepBodyHead(resp)
		return nil, resp, fmt.Errorf("websocket: dial: the response body is not writable (%T)", resp.Body)
	}
	resp.Body = http.NoBody

	var s stream
	if nc := capture.get(); nc != nil {
		s = bodyStream{ReadWriteCloser: rwc, nc: nc}
	} else {
		s = newTimerStream(rwc)
	}
	c := newConn(s, bufio.NewReaderSize(rwc, readBufferSize), true, resp.Header.Get("Sec-WebSocket-Protocol"))
	return c, resp, nil
}

// handshakeClient copies c (http.DefaultClient when nil) for one dial. When
// its transport is an *http.Transport, the copy gets a private clone whose
// dial functions record the connection, so deadlines can be set on it; a
// fresh transport also guarantees the upgrade goes out on a new
// connection, not a pooled one. Redirects keep the ws schemes working.
func handshakeClient(c *http.Client) (*http.Client, *connCapture) {
	if c == nil {
		c = http.DefaultClient
	}
	client := *c
	capture := &connCapture{}
	base := client.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	if t, ok := base.(*http.Transport); ok {
		t = t.Clone()
		//lint:ignore SA1019 a caller's legacy Transport.Dial is honoured as is
		legacyDial := t.Dial != nil
		if dial := t.DialContext; dial != nil {
			t.DialContext = capture.wrap(dial)
		} else if !legacyDial {
			var d net.Dialer
			t.DialContext = capture.wrap(d.DialContext)
		}
		if dial := t.DialTLSContext; dial != nil {
			t.DialTLSContext = capture.wrap(dial)
		}
		client.Transport = t
	}
	check := client.CheckRedirect
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		switch req.URL.Scheme {
		case "ws":
			req.URL.Scheme = "http"
		case "wss":
			req.URL.Scheme = "https"
		}
		if check != nil {
			return check(req, via)
		}
		return nil
	}
	return &client, capture
}

// connCapture records the last connection a transport dialled.
type connCapture struct {
	mu sync.Mutex
	nc net.Conn
}

type dialFunc = func(ctx context.Context, network, addr string) (net.Conn, error)

func (c *connCapture) wrap(dial dialFunc) dialFunc {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		nc, err := dial(ctx, network, addr)
		if err == nil {
			c.mu.Lock()
			c.nc = nc
			c.mu.Unlock()
		}
		return nc, err
	}
}

func (c *connCapture) get() net.Conn {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.nc
}

// keepBodyHead replaces a failed handshake's body with its first KiB, for
// error messages, and closes the connection.
func keepBodyHead(resp *http.Response) {
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	_ = resp.Body.Close()
	resp.Body = io.NopCloser(strings.NewReader(string(b)))
}

func verifyServerResponse(resp *http.Response, key string, offered []string) error {
	if resp.StatusCode != http.StatusSwitchingProtocols {
		return fmt.Errorf("expected handshake response status code %d but got %d", http.StatusSwitchingProtocols, resp.StatusCode)
	}
	if !headerHasToken(resp.Header, "Connection", "upgrade") {
		return fmt.Errorf("handshake response Connection header %q does not contain Upgrade", resp.Header.Get("Connection"))
	}
	if !headerHasToken(resp.Header, "Upgrade", "websocket") {
		return fmt.Errorf("handshake response Upgrade header %q does not contain websocket", resp.Header.Get("Upgrade"))
	}
	if got := resp.Header.Get("Sec-WebSocket-Accept"); got != acceptKey(key) {
		return fmt.Errorf("invalid Sec-WebSocket-Accept %q", got)
	}
	if proto := resp.Header.Get("Sec-WebSocket-Protocol"); proto != "" {
		ok := false
		for _, p := range offered {
			ok = ok || strings.EqualFold(p, proto)
		}
		if !ok {
			return fmt.Errorf("server selected a subprotocol that was not offered: %q", proto)
		}
	}
	if ext := resp.Header.Get("Sec-WebSocket-Extensions"); ext != "" {
		// None was offered, so the server may not select one.
		return errors.New("server selected an extension that was not offered: " + ext)
	}
	return nil
}

// acceptKey is Sec-WebSocket-Accept for a Sec-WebSocket-Key.
func acceptKey(key string) string {
	h := sha1.New()
	h.Write([]byte(key))
	h.Write([]byte("258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

// headerHasToken reports whether a comma-separated header holds token,
// case-insensitively.
func headerHasToken(h http.Header, name, token string) bool {
	for _, v := range h.Values(name) {
		for _, t := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(t), token) {
				return true
			}
		}
	}
	return false
}
