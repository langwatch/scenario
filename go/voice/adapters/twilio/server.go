package twilio

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/langwatch/scenario/go/voice/internal/mediastream"
	"github.com/langwatch/scenario/go/voice/internal/wsconn"
)

// maxWebhookBody bounds the voice webhook body. Twilio's are about 1 KB;
// the cap guards the publicly tunnelled endpoint against a huge POST.
const maxWebhookBody = 1 << 20

// webhookServer is the local HTTP server impersonating Twilio's webhook and
// Media Streams endpoints:
//
//   - POST /twilio/voice answers with <Connect><Stream> TwiML pointing at our
//     own WebSocket URL (after X-Twilio-Signature validation).
//   - GET /twilio/<nonce> and /twilio/stream upgrade to the media stream.
type webhookServer struct {
	a    *Adapter
	srv  *http.Server
	ln   net.Listener
	port int
	wg   sync.WaitGroup
}

func startServer(a *Adapter, port int) (*webhookServer, error) {
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return nil, fmt.Errorf("TwilioAgentAdapter: starting the webhook server: %w", err)
	}
	s := &webhookServer{a: a, ln: ln, port: ln.Addr().(*net.TCPAddr).Port}
	s.srv = &http.Server{Handler: s, ReadHeaderTimeout: 10 * time.Second}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		_ = s.srv.Serve(ln)
	}()
	return s, nil
}

func (s *webhookServer) baseURL() string { return "http://127.0.0.1:" + strconv.Itoa(s.port) }

// stop closes the listener and every idle or active HTTP connection.
// Media sessions (hijacked connections) are closed by the adapter.
func (s *webhookServer) stop() {
	_ = s.srv.Close()
	s.wg.Wait()
}

// ServeHTTP routes the two endpoints; everything else is a 404.
func (s *webhookServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case isUpgrade(r):
		s.a.handleUpgrade(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/twilio/voice":
		s.a.handleVoiceWebhook(w, r, s.baseURL())
	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

func isUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}

// handleVoiceWebhook answers Twilio's voice webhook with the TwiML that
// attaches the media stream to this adapter.
func (a *Adapter) handleVoiceWebhook(w http.ResponseWriter, r *http.Request, localBase string) {
	a.mu.Lock()
	// The media stream has no span of its own (it would flood), so a
	// rejected webhook is visible only through these counters.
	a.webhookCalls++
	base := a.publicBaseURL
	a.mu.Unlock()

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxWebhookBody))
	if err != nil {
		a.logger.Warn("twilio: webhook body rejected", "reason", err.Error())
		http.Error(w, "payload too large", http.StatusRequestEntityTooLarge)
		return
	}
	params := parseForm(string(body))

	if a.validateSignature {
		full := strings.TrimSuffix(base, "/")
		if full == "" {
			full = localBase
		}
		if !VerifySignature(a.authToken, full+r.URL.Path, params, r.Header.Get("X-Twilio-Signature")) {
			a.recordRejection()
			a.logger.Warn("twilio: rejecting voice webhook — missing or invalid X-Twilio-Signature",
				"from", RedactE164(params["From"]))
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
	}
	from := params["From"]
	if a.allowedCallers != nil {
		if _, ok := a.allowedCallers[from]; !ok {
			a.recordRejection()
			a.logger.Info("twilio: rejecting call from disallowed caller", "from", RedactE164(from))
			w.Header().Set("Content-Type", "application/xml")
			_, _ = io.WriteString(w, "<Response><Reject/></Response>")
			return
		}
	}
	if base == "" {
		http.Error(w, "publicBaseUrl is not set on the adapter", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/xml")
	_, _ = io.WriteString(w, `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="`+
		escapeXMLAttr(StreamWSURL(base, ""))+`"/></Connect></Response>`)
}

func (a *Adapter) recordRejection() {
	a.mu.Lock()
	a.rejected++
	a.mu.Unlock()
}

// parseForm decodes a form body; a repeated key keeps its last value.
func parseForm(body string) map[string]string {
	params := map[string]string{}
	values, _ := url.ParseQuery(body)
	for k, v := range values {
		params[k] = v[len(v)-1]
	}
	return params
}

// handleUpgrade is the one media-stream upgrade path, reached from the
// local server and from AcceptExternalUpgrade alike, so the path-nonce
// check and the media loop behave identically for both. A nonce in the
// path must match the armed a-leg nonce; the start frame's nonce is checked
// again, independently, by the media loop.
func (a *Adapter) handleUpgrade(w http.ResponseWriter, r *http.Request) {
	token, ok := strings.CutPrefix(r.URL.Path, "/twilio/")
	if !ok || token == "" || strings.Contains(token, "/") {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if token != "stream" {
		a.mu.Lock()
		expected := a.streamNonce
		a.mu.Unlock()
		if expected != "" && !NonceMatches(expected, token) {
			a.logger.Warn("twilio: media stream upgrade rejected — path nonce mismatch")
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
	}
	// Twilio sends no Origin; the socket authenticates by nonce, not origin.
	ws, err := wsconn.Accept(w, r, wsconn.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	conn := mediastream.NewConn(ws)
	defer conn.Close()
	if err := a.runStreamSession(conn); err != nil {
		a.logger.Warn("twilio: media stream failed", "error", err)
	}
}

// ServeMediaStream runs the media stream of an already-accepted WebSocket
// through this SDK-owned adapter, as if it had arrived on the local server
// (the path nonce aside, which the caller checked when it routed the
// socket). The adapter owns ws: it blocks until the stream ends, then
// closes it. Use it when a host listener accepts Twilio's dial-back for a
// call this adapter placed.
func (a *Adapter) ServeMediaStream(ws *websocket.Conn) error {
	conn := mediastream.NewWSConn(ws)
	defer conn.Close()
	return a.runStreamSession(conn)
}

// AcceptExternalUpgrade completes, on this adapter, a media-stream upgrade
// that arrived on another listener: a host platform's public listener that
// read the upgrade request, routed it by the nonce in its path and handed
// the raw connection over without completing the handshake. req is the
// request it read (nil: read it from conn); head holds bytes it read past
// the request. The connection runs through the ordinary upgrade path, so
// the nonce checks apply unchanged; the call returns at once, the stream is
// served in the background. Without a running server the connection is
// closed.
func (a *Adapter) AcceptExternalUpgrade(conn net.Conn, req *http.Request, head []byte) {
	a.mu.Lock()
	running := a.server != nil
	a.mu.Unlock()
	if !running {
		_ = conn.Close()
		return
	}
	go func() {
		w, r, err := newHijackWriter(conn, req, head)
		if err != nil {
			_ = conn.Close()
			return
		}
		a.handleUpgrade(w, r)
		w.finish()
	}()
}

// AcceptConn completes the server-side WebSocket handshake on a raw
// connection whose upgrade request has not been answered yet: a connection
// hijacked from another HTTP server, or one handed over from another
// process. req is the upgrade request if it was already read (nil: it is
// read from conn); head holds any bytes read past it, such as a pipelined
// first frame. Pass the result to [NewStream].
func AcceptConn(conn net.Conn, req *http.Request, head []byte) (*websocket.Conn, error) {
	w, r, err := newHijackWriter(conn, req, head)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		w.finish()
		return nil, err
	}
	return ws, nil
}

// AcceptStream completes the server-side handshake on a raw connection,
// as [AcceptConn] does, and returns the embedded adapter over it, as
// [NewStream] does. The connection runs on the SDK's allocation-free
// WebSocket rather than coder/websocket, so prefer it over AcceptConn
// followed by NewStream when the caller does not need the
// *websocket.Conn itself.
func AcceptStream(conn net.Conn, req *http.Request, head []byte, opts StreamOptions) (*Adapter, error) {
	w, r, err := newHijackWriter(conn, req, head)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	ws, err := wsconn.Accept(w, r, wsconn.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		w.finish()
		return nil, err
	}
	return newStream(mediastream.NewConn(ws), opts), nil
}

// hijackWriter is the http.ResponseWriter + http.Hijacker over a raw
// connection that lets websocket.Accept run outside an http.Server.
type hijackWriter struct {
	conn     net.Conn
	br       *bufio.Reader
	header   http.Header
	wrote    bool
	hijacked bool
}

func newHijackWriter(conn net.Conn, req *http.Request, head []byte) (*hijackWriter, *http.Request, error) {
	var br *bufio.Reader
	if req == nil {
		br = bufio.NewReader(conn)
		r, err := http.ReadRequest(br)
		if err != nil {
			return nil, nil, fmt.Errorf("twilio: reading the upgrade request: %w", err)
		}
		req = r
	} else {
		br = bufio.NewReaderSize(io.MultiReader(bytes.NewReader(head), conn), max(4096, len(head)))
		// Buffer the head now: the WebSocket library keeps only what is
		// already buffered when it takes the connection over.
		if len(head) > 0 {
			if _, err := br.Peek(len(head)); err != nil {
				return nil, nil, err
			}
		}
	}
	if req.ProtoMajor == 0 {
		req.Proto, req.ProtoMajor, req.ProtoMinor = "HTTP/1.1", 1, 1
	}
	if req.URL == nil {
		return nil, nil, errors.New("twilio: the upgrade request has no URL")
	}
	return &hijackWriter{conn: conn, br: br, header: http.Header{}}, req, nil
}

func (w *hijackWriter) Header() http.Header { return w.header }

func (w *hijackWriter) WriteHeader(code int) {
	if w.wrote {
		return
	}
	w.wrote = true
	var b bytes.Buffer
	fmt.Fprintf(&b, "HTTP/1.1 %d %s\r\n", code, http.StatusText(code))
	if code != http.StatusSwitchingProtocols {
		w.header.Set("Connection", "close")
	}
	_ = w.header.Write(&b)
	b.WriteString("\r\n")
	_, _ = w.conn.Write(b.Bytes())
}

func (w *hijackWriter) Write(p []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	return w.conn.Write(p)
}

func (w *hijackWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	w.hijacked = true
	return w.conn, bufio.NewReadWriter(w.br, bufio.NewWriter(w.conn)), nil
}

// finish closes the connection when the handler answered with a plain
// HTTP response instead of taking the connection over.
func (w *hijackWriter) finish() {
	if !w.hijacked {
		_ = w.conn.Close()
	}
}

var _ http.Hijacker = (*hijackWriter)(nil)
