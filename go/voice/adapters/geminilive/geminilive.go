package geminilive

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/internal/eventq"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// Defaults, the same as the JavaScript and Python SDKs.
const (
	// DefaultModel is the default Live model.
	DefaultModel = "gemini-2.5-flash-native-audio-latest"
	// DefaultVoice is the default prebuilt voice.
	DefaultVoice = "Algieba"
	// DefaultURL is the Live API WebSocket endpoint.
	DefaultURL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
)

const (
	className = "GeminiLiveAgentAdapter"
	inputRate = 16000
	// spuriousPairRecovery is the budget granted after the spurious
	// interrupted → turnComplete pair: Gemini takes ~3.5 s to produce the
	// real reply.
	spuriousPairRecovery = 10 * time.Second
	maxFrameBytes        = 64 << 20
)

var errNotConnected = errors.New(className + ": not connected")

// DialFunc opens the Live WebSocket. header carries the API key.
type DialFunc func(ctx context.Context, url string, header http.Header) (*websocket.Conn, error)

// Options configure an Adapter. Zero fields take the defaults.
type Options struct {
	// Model defaults to DefaultModel.
	Model string
	// Voice is the prebuilt voice name; defaults to DefaultVoice.
	Voice string
	// SystemInstruction is sent at session setup.
	SystemInstruction string
	// APIKey falls back to GEMINI_API_KEY, then GOOGLE_API_KEY.
	APIKey string
	// URL overrides the endpoint (tests, proxies).
	URL string
	// HTTPClient carries the WebSocket handshake.
	HTTPClient *http.Client
	// Dial replaces the WebSocket dial.
	Dial DialFunc
	// Logger defaults to slog.Default().
	Logger *slog.Logger
}

// Adapter is the Gemini Live scenario agent: the default voice turn of the
// embedded voice.Agent over a [Transport].
type Adapter struct {
	*voice.Agent
	rt *Transport
}

// New returns an adapter.
func New(o Options) *Adapter {
	rt := NewTransport(o)
	return &Adapter{Agent: voice.NewAgent(rt), rt: rt}
}

// Live returns the transport, for adapter-level calls.
func (a *Adapter) Live() *Transport { return a.rt }

// item is one entry of the inbound queue.
type item struct {
	msg    serverMessage
	closed bool
	err    error
}

// Transport speaks the Gemini Live wire protocol; it is the voice.Transport
// behind an [Adapter].
type Transport struct {
	model             string
	voiceName         string
	systemInstruction string
	apiKey            string
	url               string
	dial              DialFunc
	logger            *slog.Logger

	mu        sync.Mutex
	conn      *websocket.Conn
	events    *eventq.Queue[item]
	cancel    context.CancelFunc
	connected bool
	// iterHadAudio reports audio in the current turn, to tell the spurious
	// interrupted → turnComplete pair from a real empty turn.
	iterHadAudio bool
	// spuriousRetries counts the spurious pairs absorbed in the current
	// turn (reset by SendAudio).
	spuriousRetries int
	// interruptPending makes the in-flight (or next) ReceiveAudio return the
	// cut-off sentinel, so an interrupted turn does not replay stale audio.
	interruptPending    bool
	lastAgentTranscript string

	sendMu  sync.Mutex
	sendBuf []byte
	pcm16k  []byte
}

// NewTransport returns an unconnected transport.
func NewTransport(o Options) *Transport {
	t := &Transport{
		model:             firstNonEmpty(o.Model, DefaultModel),
		voiceName:         firstNonEmpty(o.Voice, DefaultVoice),
		systemInstruction: o.SystemInstruction,
		apiKey:            firstNonEmpty(o.APIKey, os.Getenv("GEMINI_API_KEY"), os.Getenv("GOOGLE_API_KEY")),
		url:               firstNonEmpty(o.URL, DefaultURL),
		dial:              o.Dial,
		logger:            o.Logger,
	}
	if t.logger == nil {
		t.logger = slog.Default()
	}
	if t.dial == nil {
		client := o.HTTPClient
		t.dial = func(ctx context.Context, url string, header http.Header) (*websocket.Conn, error) {
			c, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPClient: client, HTTPHeader: header})
			return c, err
		}
	}
	return t
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if v != "" {
			return v
		}
	}
	return ""
}

// Name implements voice.Named.
func (t *Transport) Name() string { return className }

// String hides the API key.
func (t *Transport) String() string {
	return fmt.Sprintf("%s(model='%s', voice='%s', api_key='***')", className, t.model, t.voiceName)
}

// GoString hides the API key from %#v.
func (t *Transport) GoString() string { return t.String() }

// Model is the Live model.
func (t *Transport) Model() string { return t.model }

// Voice is the prebuilt voice.
func (t *Transport) Voice() string { return t.voiceName }

// Capabilities implements voice.Transport. Interruption works through the
// next activityStart (Gemini cuts its in-flight reply); Interrupt itself
// stops the local drain.
func (t *Transport) Capabilities() voice.Capabilities {
	return voice.Capabilities{
		StreamingTranscripts: true,
		NativeVAD:            true,
		Interruption:         true,
		InputFormats:         []string{"pcm16/16000"},
		OutputFormats:        []string{"pcm16/24000"},
	}
}

// IsConnected implements voice.ConnectionReporter.
func (t *Transport) IsConnected() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.connected
}

// LastAgentTranscript implements voice.TranscriptSource: the output
// transcript of the current turn so far.
func (t *Transport) LastAgentTranscript() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.lastAgentTranscript
}

// ResetAgentTranscript implements voice.TranscriptSource.
func (t *Transport) ResetAgentTranscript() {
	t.mu.Lock()
	t.lastAgentTranscript = ""
	t.mu.Unlock()
}

// StreamingTranscript implements voice.StreamingTranscriber.
func (t *Transport) StreamingTranscript() string { return t.LastAgentTranscript() }

// Connect implements voice.Transport: it opens the Live session and sends
// the setup message. Gemini attributes are added to ctx's span (the
// runtime's voice.adapter.connect).
func (t *Transport) Connect(ctx context.Context) error {
	t.mu.Lock()
	if t.connected {
		t.mu.Unlock()
		return nil
	}
	t.mu.Unlock()
	conn, err := t.dial(ctx, t.url, http.Header{"x-goog-api-key": {t.apiKey}})
	if err != nil {
		return fmt.Errorf("%s: connect: %w", className, err)
	}
	conn.SetReadLimit(maxFrameBytes)
	setup, err := json.Marshal(map[string]any{"setup": t.setup()})
	if err == nil {
		err = conn.Write(ctx, websocket.MessageText, setup)
	}
	if err != nil {
		_ = conn.CloseNow()
		return fmt.Errorf("%s: setup: %w", className, err)
	}
	q := eventq.New[item]()
	readCtx, cancel := context.WithCancel(context.Background())
	t.mu.Lock()
	t.conn, t.events, t.cancel, t.connected = conn, q, cancel, true
	t.iterHadAudio, t.interruptPending = false, false
	t.mu.Unlock()
	go t.readLoop(readCtx, conn, q)
	voice.SetSpanAttributes(trace.SpanFromContext(ctx),
		attribute.String("voice.gemini.model", t.model),
		attribute.String("voice.gemini.voice", t.voiceName))
	return nil
}

// setup is the session config: audio responses in the voice, activity
// detection off (the adapter marks turn boundaries) and both transcription
// side channels on.
func (t *Transport) setup() map[string]any {
	model := t.model
	if !strings.Contains(model, "/") {
		model = "models/" + model
	}
	s := map[string]any{
		"model": model,
		"generationConfig": map[string]any{
			"responseModalities": []string{"AUDIO"},
			"speechConfig": map[string]any{
				"voiceConfig": map[string]any{"prebuiltVoiceConfig": map[string]any{"voiceName": t.voiceName}},
			},
		},
		"realtimeInputConfig":      map[string]any{"automaticActivityDetection": map[string]any{"disabled": true}},
		"inputAudioTranscription":  map[string]any{},
		"outputAudioTranscription": map[string]any{},
	}
	if t.systemInstruction != "" {
		s["systemInstruction"] = map[string]any{"parts": []map[string]any{{"text": t.systemInstruction}}}
	}
	return s
}

// Disconnect implements voice.Transport: it closes the session and ends any
// in-flight receive.
func (t *Transport) Disconnect(context.Context) error {
	t.mu.Lock()
	if !t.connected {
		t.mu.Unlock()
		return nil
	}
	conn, q, cancel := t.conn, t.events, t.cancel
	t.conn, t.connected = nil, false
	t.mu.Unlock()
	q.Clear()
	q.Push(item{closed: true})
	_ = conn.Close(websocket.StatusNormalClosure, "")
	cancel()
	return nil
}

// readLoop queues every server message until the socket closes.
func (t *Transport) readLoop(ctx context.Context, conn *websocket.Conn, q *eventq.Queue[item]) {
	var buf bytes.Buffer
	for {
		_, r, err := conn.Reader(ctx)
		if err == nil {
			buf.Reset()
			_, err = buf.ReadFrom(r)
		}
		if err != nil {
			t.mu.Lock()
			current := t.conn == conn
			t.mu.Unlock()
			if current {
				if websocket.CloseStatus(err) == -1 && !errors.Is(err, context.Canceled) {
					q.Push(item{err: fmt.Errorf("%s: %w", className, err)})
				}
				q.Push(item{closed: true})
			}
			return
		}
		if m, ok := decodeServerMessage(buf.Bytes()); ok {
			q.Push(item{msg: m})
		}
	}
}

func (t *Transport) current() (*websocket.Conn, *eventq.Queue[item], error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.connected || t.conn == nil {
		return nil, nil, errNotConnected
	}
	return t.conn, t.events, nil
}

var (
	frameActivityStart = []byte(`{"realtimeInput":{"activityStart":{}}}`)
	frameActivityEnd   = []byte(`{"realtimeInput":{"activityEnd":{}}}`)
)

// SendAudio implements voice.Transport: the chunk, resampled to 16 kHz, as
// one complete user turn between activity markers. A chunk shorter than
// one wire sample sends nothing. The wire size goes on ctx's span (the
// runtime's voice.audio.send) as voice.gemini.audio.wire_bytes.
func (t *Transport) SendAudio(ctx context.Context, chunk voice.AudioChunk) error {
	conn, _, err := t.current()
	if err != nil {
		return err
	}
	span := trace.SpanFromContext(ctx)
	t.sendMu.Lock()
	defer t.sendMu.Unlock()
	t.pcm16k = appendResampled(t.pcm16k[:0], chunk.Data, voice.PCM16SampleRate, inputRate)
	t.mu.Lock()
	t.spuriousRetries = 0
	if len(t.pcm16k) > 0 {
		// A new user turn: the reply's transcript starts afresh.
		t.lastAgentTranscript, t.iterHadAudio = "", false
	}
	t.mu.Unlock()
	voice.SetSpanAttributes(span, attribute.Int("voice.gemini.audio.wire_bytes", len(t.pcm16k)))
	if len(t.pcm16k) == 0 {
		return nil
	}
	t.sendBuf = appendAudioFrame(t.sendBuf[:0], t.pcm16k)
	for _, frame := range [][]byte{frameActivityStart, t.sendBuf, frameActivityEnd} {
		if err := conn.Write(ctx, websocket.MessageText, frame); err != nil {
			return fmt.Errorf("%s: send: %w", className, err)
		}
	}
	return nil
}

// ReceiveAudio implements voice.Transport. It returns the next audio of the
// current turn as soon as it arrives, an empty chunk when the turn
// completes (or the session closes, or Interrupt cut the turn), and absorbs
// the spurious interrupted → turnComplete pair the server emits between
// turns, granting a fresh recovery budget. At the real turnComplete it adds
// voice.gemini.turn_complete and voice.gemini.spurious_retry_count to ctx's
// span (the runtime's voice.audio.receive).
func (t *Transport) ReceiveAudio(ctx context.Context, timeout time.Duration) (voice.AudioChunk, error) {
	_, q, err := t.current()
	if err != nil {
		return voice.AudioChunk{}, err
	}
	deadline := time.Now().Add(timeout)
	pending := ""
	sawInterrupted := false
	for {
		if t.takeInterrupt() {
			return voice.AudioChunk{Transcript: pending}, nil
		}
		it, err := q.Pop(ctx, deadline)
		switch {
		case errors.Is(err, eventq.ErrWoken):
			continue
		case errors.Is(err, eventq.ErrTimeout):
			return voice.AudioChunk{}, fmt.Errorf("%s: no message within %dms: %w", className, timeout.Milliseconds(), voice.ErrReceiveTimeout)
		case err != nil:
			return voice.AudioChunk{}, err
		}
		if t.takeInterrupt() {
			return voice.AudioChunk{Transcript: pending}, nil
		}
		if it.err != nil {
			return voice.AudioChunk{}, it.err
		}
		if it.closed {
			// Closed mid-turn: a graceful end of turn, not a hang.
			return voice.AudioChunk{Transcript: pending}, nil
		}
		m := &it.msg
		if m.goAway != "" {
			return voice.AudioChunk{}, fmt.Errorf("%s: server sent goAway: %s", className, truncate(m.goAway, 300))
		}
		if !m.hasContent {
			continue
		}
		if m.interrupted {
			sawInterrupted = true
		}
		t.mu.Lock()
		if m.transcript != "" {
			pending += m.transcript
			t.lastAgentTranscript += m.transcript
		}
		if len(m.audio) > 0 {
			t.iterHadAudio = true
		}
		hadAudio, retries := t.iterHadAudio, t.spuriousRetries
		t.mu.Unlock()
		if len(m.audio) > 0 {
			return voice.AudioChunk{Data: m.audio, Transcript: pending}, nil
		}
		if !m.turnComplete {
			continue
		}
		if sawInterrupted && !hadAudio && pending == "" {
			// The spurious pair: when activityStart opens turn N+1 after turn
			// N's generationComplete, the server first emits interrupted →
			// turnComplete with no audio, then the real reply. Read on, as if
			// the receive iterator were re-created, with a fresh budget.
			t.mu.Lock()
			t.spuriousRetries++
			t.mu.Unlock()
			sawInterrupted = false
			deadline = later(deadline, time.Now().Add(spuriousPairRecovery))
			continue
		}
		voice.SetSpanAttributes(trace.SpanFromContext(ctx),
			attribute.Bool("voice.gemini.turn_complete", true),
			attribute.Int("voice.gemini.spurious_retry_count", retries))
		return voice.AudioChunk{Transcript: pending}, nil
	}
}

func (t *Transport) takeInterrupt() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.interruptPending {
		return false
	}
	t.interruptPending = false
	return true
}

// Interrupt implements voice.Interrupter: the in-flight (or next)
// ReceiveAudio returns the cut-off sentinel at once, so the interrupted
// turn does not replay stale audio into the recovery turn. Gemini itself
// cuts its reply at the next activityStart. The outcome goes on ctx's span
// (voice.adapter.interrupt) as voice.gemini.interrupt.outcome.
func (t *Transport) Interrupt(ctx context.Context) error {
	span := trace.SpanFromContext(ctx)
	t.mu.Lock()
	if !t.connected {
		t.mu.Unlock()
		voice.SetSpanAttributes(span, attribute.String("voice.gemini.interrupt.outcome", "no_op_not_connected"))
		return nil
	}
	t.interruptPending = true
	q := t.events
	t.mu.Unlock()
	q.Wake()
	voice.SetSpanAttributes(span, attribute.String("voice.gemini.interrupt.outcome", "sentinel_fired"))
	return nil
}

func later(a, b time.Time) time.Time {
	if b.After(a) {
		return b
	}
	return a
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
