package elevenlabs

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

// fakeConvAI is an in-memory ElevenLabs ConvAI: the signed-URL REST route
// and the session WebSocket it names. It records every frame the transport
// sends and lets a test push server frames.
type fakeConvAI struct {
	t   *testing.T
	srv *httptest.Server

	mu          sync.Mutex
	sent        []map[string]any
	conn        *websocket.Conn
	signedCalls int
	lastAgentID string
	lastAPIKey  string
	dialedURL   string
	closedCode  websocket.StatusCode
	connected   chan struct{}
	syncID      atomic.Int64
}

func newFake(t *testing.T) *fakeConvAI {
	t.Helper()
	f := &fakeConvAI{t: t, connected: make(chan struct{}), closedCode: -1}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/convai/conversation/get-signed-url", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.signedCalls++
		f.lastAgentID = r.URL.Query().Get("agent_id")
		f.lastAPIKey = r.Header.Get("xi-api-key")
		f.mu.Unlock()
		wsURL := "ws" + strings.TrimPrefix(f.srv.URL, "http") + "/convai?token=signed"
		_ = json.NewEncoder(w).Encode(map[string]string{"signed_url": wsURL})
	})
	mux.HandleFunc("/convai", f.serveWS)
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeConvAI) serveWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(maxMessageBytes)
	f.mu.Lock()
	f.conn = conn
	f.dialedURL = r.URL.String()
	select {
	case <-f.connected:
	default:
		close(f.connected)
	}
	f.mu.Unlock()
	for {
		_, data, err := conn.Read(context.Background())
		if err != nil {
			f.mu.Lock()
			f.closedCode = websocket.CloseStatus(err)
			f.mu.Unlock()
			return
		}
		var m map[string]any
		if json.Unmarshal(data, &m) != nil {
			m = map[string]any{"_raw": string(data)}
		}
		f.mu.Lock()
		f.sent = append(f.sent, m)
		f.mu.Unlock()
	}
}

// options are transport options pointing at the fake.
func (f *fakeConvAI) options(agentID string) Options {
	return Options{
		AgentID:    agentID,
		APIKey:     "sk_fake",
		BaseURL:    f.srv.URL,
		HTTPClient: f.srv.Client(),
		Logger:     slog.New(slog.DiscardHandler),
	}
}

// connect returns a connected transport over the fake, disconnected at the
// end of the test.
func (f *fakeConvAI) connect(o Options) *Transport {
	f.t.Helper()
	tr, err := New(o)
	if err != nil {
		f.t.Fatalf("New: %v", err)
	}
	if err := tr.Connect(context.Background()); err != nil {
		f.t.Fatalf("Connect: %v", err)
	}
	f.t.Cleanup(func() { _ = tr.Disconnect(context.Background()) })
	select {
	case <-f.connected:
	case <-time.After(2 * time.Second):
		f.t.Fatal("the transport never reached the WebSocket")
	}
	// The handshake is the first frame; wait for it so frame indexes are
	// stable.
	f.waitFor(func() bool { return len(f.frames()) > 0 }, "the handshake")
	return tr
}

// emit sends one server frame.
func (f *fakeConvAI) emit(event any) {
	f.t.Helper()
	data, err := json.Marshal(event)
	if err != nil {
		f.t.Fatal(err)
	}
	f.emitRaw(string(data))
}

func (f *fakeConvAI) emitRaw(s string) {
	f.t.Helper()
	if err := f.tryEmit([]byte(s)); err != nil {
		f.t.Fatalf("emit: %v", err)
	}
}

// tryEmit sends one raw server frame, for background streams that may
// outlive the session.
func (f *fakeConvAI) tryEmit(data []byte) error {
	f.mu.Lock()
	conn := f.conn
	f.mu.Unlock()
	return conn.Write(context.Background(), websocket.MessageText, data)
}

func TestMain(m *testing.M) {
	os.Setenv("SCENARIO_DISABLE_SIMULATION_REPORT_INFO", "1")
	os.Unsetenv("LANGWATCH_API_KEY")
	os.Setenv("SCENARIO_LOG_LEVEL", "off")
	slog.SetDefault(slog.New(slog.DiscardHandler))
	os.Exit(m.Run())
}

// sync waits until the transport processed every frame emitted so far: it
// pings and waits for the pong (the read loop handles frames in order).
// The ping is itself a frame, so tests counting frames do not use it.
func (f *fakeConvAI) sync() {
	f.t.Helper()
	id := 1_000_000 + f.syncID.Add(1)
	f.emit(map[string]any{"type": "ping", "ping_event": map[string]any{"event_id": id}})
	f.waitFor(func() bool {
		for _, m := range f.frames() {
			if m["type"] == "pong" && m["event_id"] == float64(id) {
				return true
			}
		}
		return false
	}, "the sync pong")
}

// closeSession closes the WebSocket from the server side.
func (f *fakeConvAI) closeSession(code websocket.StatusCode) {
	f.mu.Lock()
	conn := f.conn
	f.mu.Unlock()
	_ = conn.Close(code, "closed")
}

// dropSession kills the connection without a close handshake.
func (f *fakeConvAI) dropSession() {
	f.mu.Lock()
	conn := f.conn
	f.mu.Unlock()
	conn.CloseNow()
}

func (f *fakeConvAI) frames() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]map[string]any(nil), f.sent...)
}

func (f *fakeConvAI) clearFrames() {
	f.mu.Lock()
	f.sent = nil
	f.mu.Unlock()
}

func (f *fakeConvAI) waitFor(cond func() bool, what string) {
	f.t.Helper()
	waitFor(f.t, cond, what)
}

func waitFor(t *testing.T, cond func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// audioFrames decodes the user_audio_chunk frames among frames.
func audioFrames(frames []map[string]any) [][]byte {
	var out [][]byte
	for _, m := range frames {
		if s, ok := m["user_audio_chunk"].(string); ok {
			b, _ := base64.StdEncoding.DecodeString(s)
			out = append(out, b)
		}
	}
	return out
}

func framesOfType(frames []map[string]any, typ string) []map[string]any {
	var out []map[string]any
	for _, m := range frames {
		if m["type"] == typ {
			out = append(out, m)
		}
	}
	return out
}

func isSilent(b []byte) bool {
	for _, x := range b {
		if x != 0 {
			return false
		}
	}
	return true
}

func audioEvent(pcm []byte, eventID ...int) map[string]any {
	ev := map[string]any{"audio_base_64": base64.StdEncoding.EncodeToString(pcm)}
	if len(eventID) > 0 {
		ev["event_id"] = eventID[0]
	}
	return map[string]any{"type": "audio", "audio_event": ev}
}

func pingEvent(id int) map[string]any {
	return map[string]any{"type": "ping", "ping_event": map[string]any{"event_id": id, "ping_ms": 5}}
}

// logBuffer is a concurrency-safe log sink.
type logBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (l *logBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *logBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func (l *logBuffer) logger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(l, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

var _ io.Writer = (*logBuffer)(nil)

func must[T any](v T, err error) T {
	if err != nil {
		panic(fmt.Sprint(err))
	}
	return v
}

// recorder is a private tracer provider recording ended spans.
type recorder struct {
	exp    *tracetest.InMemoryExporter
	tracer trace.Tracer
}

func newRecorder() *recorder {
	exp := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sdktrace.NewSimpleSpanProcessor(exp)))
	return &recorder{exp: exp, tracer: tp.Tracer("test")}
}

// attrs returns the attributes of the first ended span named name.
func (r *recorder) attrs(name string) map[attribute.Key]attribute.Value {
	for _, s := range r.exp.GetSpans() {
		if s.Name == name {
			out := map[attribute.Key]attribute.Value{}
			for _, kv := range s.Attributes {
				out[kv.Key] = kv.Value
			}
			return out
		}
	}
	return nil
}

// stamped returns the names of ended spans carrying key, in end order.
func (r *recorder) stamped(key attribute.Key) []string {
	var names []string
	for _, s := range r.exp.GetSpans() {
		for _, kv := range s.Attributes {
			if kv.Key == key {
				names = append(names, s.Name)
			}
		}
	}
	return names
}

func encodeJSON(v any) ([]byte, error) { return json.Marshal(v) }

func quietLogger() *slog.Logger { return slog.New(slog.DiscardHandler) }
