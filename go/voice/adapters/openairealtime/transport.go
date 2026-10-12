package openairealtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/broker"
	"github.com/langwatch/scenario/go/voice/internal/eventq"
	"github.com/langwatch/scenario/go/voice/internal/wsconn"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// className is the adapter name reported in spans, warnings and errors: the
// JavaScript SDK's class name, so traces from both SDKs group together.
const className = "OpenAIRealtimeAgentAdapter"

// maxFrameBytes bounds one inbound frame; audio deltas run to a few hundred
// KiB at most.
const maxFrameBytes = 64 << 20

var (
	errNotConnected = errors.New(className + ": not connected")
	errTimedOut     = fmt.Errorf(className+": receiveAudio timed out: %w", voice.ErrReceiveTimeout)
	errSocketClosed = errors.New(className + ": socket closed")
	errDisconnected = errors.New(className + ": disconnected")
)

// DialFunc opens the Realtime WebSocket. header carries the Authorization
// bearer. A custom DialFunc's coder/websocket connection is used as is; the
// default dial uses the SDK's allocation-free WebSocket.
type DialFunc func(ctx context.Context, url string, header http.Header) (*websocket.Conn, error)

// dialFunc is the dial the transport runs, over either implementation.
type dialFunc func(ctx context.Context, url string, header http.Header) (wsconn.Conn, error)

// coderDial adapts a public DialFunc.
func coderDial(d DialFunc) dialFunc {
	return func(ctx context.Context, url string, header http.Header) (wsconn.Conn, error) {
		c, err := d(ctx, url, header)
		if err != nil {
			return nil, err
		}
		return wsconn.FromCoder(c), nil
	}
}

// Transport speaks the OpenAI Realtime wire protocol: it is the
// voice.Transport behind an [Adapter]. Use it directly for adapter-level
// work (SendText, SpeakUserTurn, the transcripts); scenarios use the
// Adapter.
type Transport struct {
	model        string
	voiceName    string
	instructions string
	tools        []Tool
	apiKey       string
	apiKeySource string
	url          string
	mint         *broker.Endpoint
	httpClient   *http.Client
	dial         dialFunc
	logger       *slog.Logger

	// UserTurnTailTimeout is the per-frame idle timeout ending a spoken user
	// turn (SpeakUserTurn and the autonomous user turn). Default 15s.
	UserTurnTailTimeout time.Duration

	mu         sync.Mutex
	conn       wsconn.Conn
	events     *eventq.Queue[event]
	closeErr   error
	cancelRead context.CancelFunc

	lastUserTranscript  string
	lastAgentTranscript string
	agentTranscriptBuf  string
	// pendingAudioBytes counts bytes appended to input_audio_buffer since the
	// last commit; non-zero means ReceiveAudio commits and requests a
	// response before it waits.
	pendingAudioBytes int
	// responseActive is true while the server streams a response
	// (response.created until response.done / response.cancelled): a
	// response.create sent then is deferred and fired at the terminal
	// event, never doubled.
	responseActive         bool
	deferredResponseCreate bool
	turnTools              toolCalls

	brokerSessionID string
	sessionUsage    broker.Usage

	sendMu  sync.Mutex
	sendBuf []byte
}

// Capabilities implements voice.Transport: streaming transcripts, native
// VAD, and response.cancel as a first-class interrupt.
func (t *Transport) Capabilities() voice.Capabilities {
	return voice.Capabilities{
		StreamingTranscripts: true,
		NativeVAD:            true,
		Interruption:         true,
		InputFormats:         []string{"pcm16/24000"},
		OutputFormats:        []string{"pcm16/24000"},
	}
}

// Name implements voice.Named.
func (t *Transport) Name() string { return className }

// String hides the API key when the transport lands in logs or errors.
func (t *Transport) String() string {
	return fmt.Sprintf("%s(model='%s', voice='%s', api_key='***')", className, t.model, t.voiceName)
}

// GoString hides the API key from %#v.
func (t *Transport) GoString() string { return t.String() }

// URL is the Realtime endpoint the transport dials.
func (t *Transport) URL() string { return t.url }

// Brokered reports whether the live session was minted by a gateway (the
// mint answered with X-LangWatch-Session-Id). Only true after Connect.
func (t *Transport) Brokered() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.brokerSessionID != ""
}

// IsConnected implements voice.ConnectionReporter.
func (t *Transport) IsConnected() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.conn != nil
}

// LastUserTranscript is the latest user transcript from the input
// transcription pipeline.
func (t *Transport) LastUserTranscript() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.lastUserTranscript
}

// LastAgentTranscript implements voice.TranscriptSource: the latest
// finalized model transcript.
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

// StreamingTranscript implements voice.StreamingTranscriber: the transcript
// of the utterance in progress, else the last finalized one.
func (t *Transport) StreamingTranscript() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.agentTranscriptBuf != "" {
		return t.agentTranscriptBuf
	}
	return t.lastAgentTranscript
}

// ---------------------------------------------------------------- lifecycle

// Connect implements voice.Transport: it acquires the socket credential
// (minting a session when an endpoint resolves), opens the Realtime
// WebSocket and sends the initial session.update. Realtime attributes are
// added to ctx's span (the runtime's voice.adapter.connect).
func (t *Transport) Connect(ctx context.Context) error {
	// A reused transport starts each connection with a clean slate.
	t.mu.Lock()
	t.responseActive, t.deferredResponseCreate = false, false
	t.closeErr = nil
	t.brokerSessionID, t.sessionUsage = "", nil
	t.mu.Unlock()

	span := trace.SpanFromContext(ctx)
	cred, err := broker.AcquireSocketKey(ctx, t.mint,
		broker.Fallback{APIKey: t.apiKey, Source: t.apiKeySource},
		broker.Params{Model: t.model, HTTPClient: t.httpClient, Logger: t.logger},
		className+": no API key. Set OPENAI_API_KEY or pass Options.APIKey.")
	if err != nil {
		return err
	}
	if cred.Minted {
		t.mu.Lock()
		t.brokerSessionID = cred.SessionID
		// Start a gateway session's total at zero, not nil: nil reports
		// nothing at disconnect and leaves the spend record open.
		if cred.SessionID != "" {
			t.sessionUsage = broker.ZeroUsage()
		}
		t.mu.Unlock()
		voice.SetSpanAttributes(span,
			attribute.Bool("voice.realtime.brokered", cred.SessionID != ""),
			attribute.String("voice.realtime.session_id", cred.SessionID))
	}

	// No OpenAI-Beta header: the GA endpoint rejects the Beta opt-in.
	conn, err := t.dial(ctx, t.url, http.Header{"Authorization": {"Bearer " + cred.SocketKey}})
	if err != nil {
		// The mint booked a session and nothing will ever report against it:
		// close it at zero rather than hold one of the key's session slots.
		t.reportUsage(ctx)
		return err
	}
	conn.SetReadLimit(maxFrameBytes)

	q := eventq.New[event]()
	readCtx, cancel := context.WithCancel(context.Background())
	t.mu.Lock()
	t.conn, t.events, t.cancelRead = conn, q, cancel
	t.mu.Unlock()
	go t.readLoop(readCtx, conn, q)

	if err := t.writeJSON(ctx, map[string]any{"type": "session.update", "session": t.sessionConfig()}); err != nil {
		return err
	}
	voice.SetSpanAttributes(span,
		attribute.String("voice.realtime.model", t.model),
		attribute.String("voice.realtime.voice", t.voiceName),
		attribute.String("voice.realtime.session_type", "realtime"),
		attribute.Int("voice.realtime.tool_count", len(t.tools)))
	return nil
}

// sessionConfig is the GA session: audio formats under audio.input/output,
// the voice under audio.output, and turn detection off, so the adapter owns
// turn boundaries (commit + response.create after each user turn).
func (t *Transport) sessionConfig() map[string]any {
	pcm := map[string]any{"type": "audio/pcm", "rate": voice.PCM16SampleRate}
	cfg := map[string]any{
		"type":  "realtime",
		"model": t.model,
		"audio": map[string]any{
			"input": map[string]any{
				"format": pcm,
				// Only the inline transcript side channel; the session
				// transcribes the user's audio internally regardless.
				"transcription":  map[string]any{"model": TranscriptionModel},
				"turn_detection": nil,
			},
			"output": map[string]any{"format": pcm, "voice": t.voiceName},
		},
	}
	if t.instructions != "" {
		cfg["instructions"] = t.instructions
	}
	if len(t.tools) > 0 {
		cfg["tools"] = t.tools
	}
	return cfg
}

// Disconnect implements voice.Transport: it reports the session's usage to
// a gateway that minted it, fails any in-flight receive and closes the
// socket. A second call is a no-op.
func (t *Transport) Disconnect(ctx context.Context) error {
	t.mu.Lock()
	conn, q, cancel := t.conn, t.events, t.cancelRead
	if conn == nil {
		t.mu.Unlock()
		return nil
	}
	t.conn = nil
	t.mu.Unlock()

	// Report before tearing the socket down: OpenAI reports usage over the
	// socket, so this is the only path by which the numbers reach a gateway.
	t.reportUsage(ctx)

	t.mu.Lock()
	t.responseActive, t.deferredResponseCreate = false, false
	t.closeErr = errDisconnected
	t.mu.Unlock()
	q.Clear()
	q.Wake()
	_ = conn.Close(wsconn.StatusNormalClosure, "")
	cancel()
	return nil
}

// readLoop decodes every inbound frame into the event queue until the
// socket closes.
func (t *Transport) readLoop(ctx context.Context, conn wsconn.Conn, q *eventq.Queue[event]) {
	var buf []byte
	for {
		var err error
		_, buf, err = conn.Read(ctx, buf[:0])
		if err != nil {
			t.socketClosed(conn, q, err)
			return
		}
		ev, ok := decodeEvent(buf)
		if !ok {
			continue // a non-JSON frame is dropped
		}
		t.captureUsage(&ev)
		q.Push(ev)
	}
}

// socketClosed fails the receive loop of a socket that is still current.
func (t *Transport) socketClosed(conn wsconn.Conn, q *eventq.Queue[event], err error) {
	t.mu.Lock()
	if t.conn != conn {
		t.mu.Unlock()
		return
	}
	if wsconn.IsClosed(err) || errors.Is(err, context.Canceled) {
		err = errSocketClosed
	} else {
		err = fmt.Errorf("%s: %w", className, err)
	}
	t.closeErr = err
	t.mu.Unlock()
	q.Wake()
}

// captureUsage adds the usage OpenAI reports on response.done into the
// session total. It runs on the read loop, so a drain that ends on tail
// silence before reading the terminal event still counts it.
func (t *Transport) captureUsage(ev *event) {
	if ev.Type != evResponseDone {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.brokerSessionID == "" {
		return
	}
	if u, ok := ev.usage(); ok {
		t.sessionUsage = broker.AccumulateUsage(t.sessionUsage, u)
	}
}

// reportUsage closes the gateway session's spend record with what the
// socket measured. Taking the usage first makes a second call a no-op.
func (t *Transport) reportUsage(ctx context.Context) {
	t.mu.Lock()
	usage, id := t.sessionUsage, t.brokerSessionID
	t.sessionUsage = nil
	t.mu.Unlock()
	if t.mint == nil || id == "" || usage == nil {
		return
	}
	broker.ReportUsage(ctx, *t.mint, id, usage, broker.ReportParams{
		HTTPClient: t.httpClient,
		OnError:    func(err error) { t.logger.Debug("voice broker usage report failed", "error", err) },
	})
}

// ---------------------------------------------------------------------- I/O

func (t *Transport) current() (wsconn.Conn, *eventq.Queue[event], error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.conn == nil {
		return nil, nil, errNotConnected
	}
	return t.conn, t.events, nil
}

func (t *Transport) write(ctx context.Context, b []byte) error {
	conn, _, err := t.current()
	if err != nil {
		return err
	}
	return conn.Write(ctx, wsconn.MessageText, b)
}

func (t *Transport) writeJSON(ctx context.Context, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return t.write(ctx, b)
}

var (
	frameCommit         = []byte(`{"type":"input_audio_buffer.commit"}`)
	frameResponseCreate = []byte(`{"type":"response.create"}`)
	frameResponseCancel = []byte(`{"type":"response.cancel"}`)
)

// SendAudio implements voice.Transport: it appends the chunk to the model's
// input audio buffer. Commit and response.create wait for the next
// ReceiveAudio, so a user turn streamed as many chunks is one turn.
func (t *Transport) SendAudio(ctx context.Context, chunk voice.AudioChunk) error {
	t.sendMu.Lock()
	t.sendBuf = appendAudioFrame(t.sendBuf[:0], chunk.Data)
	err := t.write(ctx, t.sendBuf)
	t.sendMu.Unlock()
	if err != nil {
		return err
	}
	t.mu.Lock()
	t.pendingAudioBytes += len(chunk.Data)
	t.mu.Unlock()
	return nil
}

// Interrupt implements voice.Interrupter: response.cancel stops the model's
// generation at once.
func (t *Transport) Interrupt(ctx context.Context) error {
	return t.write(ctx, frameResponseCancel)
}

// SendText injects text into the session as a user message and requests a
// response (deferred while one is active).
func (t *Transport) SendText(ctx context.Context, text string) error {
	if _, _, err := t.current(); err != nil {
		return err
	}
	item := map[string]any{
		"type": "conversation.item.create",
		"item": map[string]any{
			"type":    "message",
			"role":    "user",
			"content": []map[string]any{{"type": "input_text", "text": text}},
		},
	}
	if err := t.writeJSON(ctx, item); err != nil {
		return err
	}
	t.mu.Lock()
	create := !t.responseActive
	if !create {
		t.deferredResponseCreate = true
	}
	t.mu.Unlock()
	if create {
		return t.write(ctx, frameResponseCreate)
	}
	return nil
}

// ReceiveAudio implements voice.Transport. It commits pending user audio
// and requests a response, then reads server events until an audio delta
// arrives and returns its PCM16. Transcript, tool-call and response
// lifecycle events update the transport's state on the way; an error event
// fails the call. A turn that called tools and produced no audio ends with
// an empty chunk at response.done.
//
// Response markers (voice.realtime.response.*) and
// voice.realtime.tool_call_count go on ctx's span, the runtime's
// voice.audio.receive.
func (t *Transport) ReceiveAudio(ctx context.Context, timeout time.Duration) (voice.AudioChunk, error) {
	_, q, err := t.current()
	if err != nil {
		return voice.AudioChunk{}, err
	}
	if err := t.commitPending(ctx); err != nil {
		return voice.AudioChunk{}, err
	}
	span := trace.SpanFromContext(ctx)
	deadline := time.Now().Add(timeout)
	for {
		t.mu.Lock()
		closeErr := t.closeErr
		t.mu.Unlock()
		if closeErr != nil {
			return voice.AudioChunk{}, closeErr
		}
		ev, err := q.Pop(ctx, deadline)
		switch {
		case errors.Is(err, eventq.ErrWoken):
			continue
		case errors.Is(err, eventq.ErrTimeout):
			return voice.AudioChunk{}, errTimedOut
		case err != nil:
			return voice.AudioChunk{}, err
		}
		chunk, done, err := t.handle(ctx, span, &ev)
		if done || err != nil {
			return chunk, err
		}
	}
}

// commitPending commits the user audio appended since the last commit and
// requests a response, deferring it while one is active.
func (t *Transport) commitPending(ctx context.Context) error {
	t.mu.Lock()
	if t.pendingAudioBytes == 0 {
		t.mu.Unlock()
		return nil
	}
	t.pendingAudioBytes = 0
	create := !t.responseActive
	if !create {
		t.deferredResponseCreate = true
	}
	t.mu.Unlock()
	if err := t.write(ctx, frameCommit); err != nil {
		return err
	}
	if create {
		return t.write(ctx, frameResponseCreate)
	}
	return nil
}

// handle applies one server event. done reports that ReceiveAudio returns
// chunk.
func (t *Transport) handle(ctx context.Context, span trace.Span, ev *event) (chunk voice.AudioChunk, done bool, err error) {
	switch ev.Type {
	case evAudioDelta, evAudioDeltaBeta:
		// PCM16 holds whole samples; an odd payload is an upstream codec
		// bug, surfaced rather than truncated.
		c, err := voice.NewAudioChunk(ev.audio, "")
		return c, true, err
	case evTranscriptDelta, evTranscriptDeltaBeta:
		t.mu.Lock()
		t.agentTranscriptBuf += ev.Delta
		t.mu.Unlock()
	case evTranscriptDone, evTranscriptDoneBeta:
		t.mu.Lock()
		switch {
		case ev.Transcript != "":
			t.lastAgentTranscript = ev.Transcript
		case t.agentTranscriptBuf != "":
			t.lastAgentTranscript = t.agentTranscriptBuf
		}
		t.agentTranscriptBuf = ""
		t.mu.Unlock()
	case evInputTranscription:
		t.mu.Lock()
		t.lastUserTranscript = ev.Transcript
		t.mu.Unlock()
	case evFunctionArgsDelta:
		t.mu.Lock()
		t.turnTools.addDelta(ev.CallID, ev.Delta)
		t.mu.Unlock()
	case evFunctionArgsDone:
		t.finalizeToolCall(ev.CallID, ev.Name, ev.Arguments)
	case evOutputItemAdded, evOutputItemDone:
		if it := ev.Item; it != nil && it.Type == itemTypeFunctionCall {
			if ev.Type == evOutputItemAdded {
				// The shell arrives before the arguments stream: keep the name.
				t.mu.Lock()
				t.turnTools.noteName(it.CallID, it.Name)
				t.mu.Unlock()
			} else {
				t.finalizeToolCall(it.CallID, it.Name, it.Arguments)
			}
		}
	case evResponseCreated:
		span.AddEvent("voice.realtime.response.created")
		t.mu.Lock()
		t.responseActive = true
		t.mu.Unlock()
	case evResponseDone, evResponseCancelled:
		t.mu.Lock()
		t.responseActive = false
		fire := t.deferredResponseCreate
		if fire {
			t.deferredResponseCreate = false
			// Set eagerly: the tool-only return below can leave before the
			// server's response.created echo is read.
			t.responseActive = true
		}
		calls := len(t.turnTools.completed)
		t.mu.Unlock()
		if fire {
			if err := t.write(ctx, frameResponseCreate); err != nil {
				return voice.AudioChunk{}, true, err
			}
		}
		span.AddEvent("voice.realtime." + ev.Type)
		voice.SetSpanAttributes(span, attribute.Int("voice.realtime.tool_call_count", calls))
		// A tool-only turn ends here with an empty chunk so the drain stops
		// and the tool calls surface; an empty turn (no calls) still waits
		// for its timeout.
		if calls > 0 {
			return voice.AudioChunk{}, true, nil
		}
	case evError:
		return voice.AudioChunk{}, true, fmt.Errorf("%s: server error — %s", className, ev.errorMessage())
	}
	return voice.AudioChunk{}, false, nil
}

func (t *Transport) finalizeToolCall(callID, name, args string) {
	t.mu.Lock()
	ok := t.turnTools.finalize(callID, name, args)
	t.mu.Unlock()
	if !ok {
		t.logger.Debug(className + ": function-call event with no call_id; skipping")
	}
}

// resetToolCalls clears the per-turn tool-call state at a turn start.
func (t *Transport) resetToolCalls() {
	t.mu.Lock()
	t.turnTools.reset()
	t.mu.Unlock()
}

// ToolCalls returns the tool calls finalized in the current turn.
func (t *Transport) ToolCalls() []ToolCall {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]ToolCall(nil), t.turnTools.completed...)
}
