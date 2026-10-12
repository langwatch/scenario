package ws

import (
	"bufio"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// AcceptOptions configure Accept and AcceptConn.
type AcceptOptions struct {
	// Subprotocols the server supports, in preference order; the first one
	// the client also offered is selected.
	Subprotocols []string
	// InsecureSkipVerify accepts any Origin. Without it, a request with an
	// Origin header must come from the request's own host (browsers send
	// Origin; Twilio and other servers do not).
	InsecureSkipVerify bool
}

// handshakeError is a rejected upgrade request and the status it is
// answered with.
type handshakeError struct {
	status int
	msg    string
	header http.Header
}

func (e *handshakeError) Error() string { return "websocket: accept: " + e.msg }

// Accept completes the server side of the handshake on an HTTP request. A
// request that is not a valid upgrade is answered with an HTTP error and
// reported as an error. w must implement http.Hijacker.
func Accept(w http.ResponseWriter, r *http.Request, o *AcceptOptions) (*Conn, error) {
	if o == nil {
		o = &AcceptOptions{}
	}
	key, proto, err := verifyClientRequest(r, o)
	if err != nil {
		var he *handshakeError
		if errors.As(err, &he) {
			for k, v := range he.header {
				w.Header()[k] = v
			}
			http.Error(w, he.msg, he.status)
		}
		return nil, err
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
		return nil, errors.New("websocket: accept: the response writer does not implement http.Hijacker")
	}
	nc, brw, err := hj.Hijack()
	if err != nil {
		return nil, fmt.Errorf("websocket: accept: hijack: %w", err)
	}
	// Headers the handler set before accepting go out with the 101.
	return upgrade(nc, brw.Reader, key, proto, w.Header())
}

// AcceptConn completes the server side of the handshake on a raw
// connection whose upgrade request r was already read from br (br also
// holds any bytes read past it, such as a pipelined first frame; nil reads
// straight from nc). A request that is not a valid upgrade is answered with
// an HTTP error, nc is closed and the error returned.
func AcceptConn(nc net.Conn, br *bufio.Reader, r *http.Request, o *AcceptOptions) (*Conn, error) {
	if o == nil {
		o = &AcceptOptions{}
	}
	key, proto, err := verifyClientRequest(r, o)
	if err != nil {
		var he *handshakeError
		if errors.As(err, &he) {
			writeErrorResponse(nc, he)
		}
		_ = nc.Close()
		return nil, err
	}
	return upgrade(nc, br, key, proto, nil)
}

// upgrade writes the 101 response and returns the server connection.
func upgrade(nc net.Conn, br *bufio.Reader, key, proto string, extra http.Header) (*Conn, error) {
	// An http.Server leaves its own read and write deadlines on a hijacked
	// connection; the WebSocket sets its own from here on.
	_ = nc.SetDeadline(time.Time{})
	var b strings.Builder
	b.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ")
	b.WriteString(acceptKey(key))
	b.WriteString("\r\n")
	if proto != "" {
		b.WriteString("Sec-WebSocket-Protocol: " + proto + "\r\n")
	}
	for k, vs := range extra {
		switch http.CanonicalHeaderKey(k) {
		case "Upgrade", "Connection", "Sec-Websocket-Accept", "Sec-Websocket-Protocol", "Content-Type", "Content-Length":
			continue
		}
		for _, v := range vs {
			b.WriteString(k + ": " + v + "\r\n")
		}
	}
	b.WriteString("\r\n")
	if _, err := nc.Write([]byte(b.String())); err != nil {
		_ = nc.Close()
		return nil, fmt.Errorf("websocket: accept: writing the handshake response: %w", err)
	}
	if br == nil {
		br = bufio.NewReaderSize(nc, readBufferSize)
	}
	return newConn(nc, br, false, proto), nil
}

func writeErrorResponse(nc net.Conn, he *handshakeError) {
	var b strings.Builder
	fmt.Fprintf(&b, "HTTP/1.1 %d %s\r\n", he.status, http.StatusText(he.status))
	for k, vs := range he.header {
		for _, v := range vs {
			b.WriteString(k + ": " + v + "\r\n")
		}
	}
	fmt.Fprintf(&b, "Content-Type: text/plain; charset=utf-8\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", len(he.msg), he.msg)
	_ = nc.SetWriteDeadline(time.Now().Add(closeTimeout))
	_, _ = nc.Write([]byte(b.String()))
}

// verifyClientRequest checks an upgrade request (RFC 6455 4.2.1) and
// returns its key and the selected subprotocol.
func verifyClientRequest(r *http.Request, o *AcceptOptions) (key, proto string, err error) {
	bad := func(status int, format string, args ...any) (string, string, error) {
		return "", "", &handshakeError{status: status, msg: fmt.Sprintf(format, args...)}
	}
	if !r.ProtoAtLeast(1, 1) {
		return bad(http.StatusUpgradeRequired, "WebSocket requires HTTP/1.1, got %s", r.Proto)
	}
	if !headerHasToken(r.Header, "Connection", "upgrade") {
		return bad(http.StatusUpgradeRequired, "Connection header %q does not contain Upgrade", r.Header.Get("Connection"))
	}
	if !headerHasToken(r.Header, "Upgrade", "websocket") {
		return bad(http.StatusUpgradeRequired, "Upgrade header %q does not contain websocket", r.Header.Get("Upgrade"))
	}
	if r.Method != http.MethodGet {
		return bad(http.StatusMethodNotAllowed, "WebSocket upgrade must be a GET, got %s", r.Method)
	}
	if v := r.Header.Get("Sec-WebSocket-Version"); v != "13" {
		return "", "", &handshakeError{
			status: http.StatusBadRequest,
			msg:    fmt.Sprintf("unsupported Sec-WebSocket-Version %q", v),
			header: http.Header{"Sec-WebSocket-Version": {"13"}},
		}
	}
	key = strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if raw, err := base64.StdEncoding.DecodeString(key); err != nil || len(raw) != 16 {
		return bad(http.StatusBadRequest, "invalid Sec-WebSocket-Key %q", key)
	}
	if !o.InsecureSkipVerify {
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || !strings.EqualFold(u.Host, r.Host) {
				return bad(http.StatusForbidden, "request Origin %q is not the request's host %q", origin, r.Host)
			}
		}
	}
	proto = selectSubprotocol(r, o.Subprotocols)
	return key, proto, nil
}

func selectSubprotocol(r *http.Request, supported []string) string {
	if len(supported) == 0 {
		return ""
	}
	var offered []string
	for _, v := range r.Header.Values("Sec-WebSocket-Protocol") {
		for _, p := range strings.Split(v, ",") {
			offered = append(offered, strings.TrimSpace(p))
		}
	}
	for _, s := range supported {
		for _, p := range offered {
			if strings.EqualFold(s, p) {
				return s
			}
		}
	}
	return ""
}
