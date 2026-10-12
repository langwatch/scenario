// Package pipecat is the voice transport to a user-run Pipecat bot, a port
// of the JavaScript SDK's PipecatAgentAdapter.
//
// Pipecat builds voice agents; the user runs the bot separately (for
// example python bot.py -t twilio --port 8765) and this adapter connects to
// it as a WebSocket client. A bot on the "-t twilio" transport speaks Twilio
// Media Streams on its socket, so the adapter impersonates Twilio: a
// synthetic connected + start handshake with stream and call SIDs, then
// base64 µ-law 8 kHz media frames both ways. Transport "webrtc"
// (SmallWebRTC) is not implemented: Connect fails with a
// voice.PendingTransportError.
package pipecat

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/internal/mediastream"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// Name is the adapter name reported in spans and errors.
const Name = "PipecatAgentAdapter"

// Transport modes.
const (
	TransportWebSocket = "websocket"
	TransportWebRTC    = "webrtc"
)

// Options configure an Adapter.
type Options struct {
	// URL is the bot's WebSocket endpoint (transport "websocket").
	URL string
	// SignalingURL is the WebRTC signaling endpoint (transport "webrtc").
	SignalingURL string
	// Transport is "websocket" (default) or "webrtc".
	Transport string
	// AudioFormat and SampleRate describe the wire audio the bot expects;
	// default "mulaw" at 8000 Hz.
	AudioFormat string
	SampleRate  int
	// StreamSID and CallSID are the synthetic Twilio SIDs of the handshake;
	// generated per connection when empty.
	StreamSID, CallSID string
	// DialOptions configure the WebSocket dial (HTTP client, headers).
	DialOptions *websocket.DialOptions
	// DisablePacing sends outbound frames back to back instead of at real
	// time (20 ms each). Tests only: an unpaced utterance trips the bot's VAD.
	DisablePacing bool
	// Logger receives dropped-batch warnings; default slog.Default().
	Logger *slog.Logger
}

// Adapter is the Pipecat transport. It is safe for concurrent use.
type Adapter struct {
	opts   Options
	logger *slog.Logger

	queue mediastream.Queue

	sendMu sync.Mutex
	sender mediastream.Sender

	mu        sync.Mutex
	conn      *mediastream.WSConn
	streamSID string
	callSID   string
	// closed is set once the socket closed: receives drain what is queued,
	// then fail.
	closed bool
	// interrupted is set by Interrupt until the next user turn's SendAudio:
	// the next receive returns an empty end-of-turn chunk and late frames of
	// the interrupted bot turn are dropped.
	interrupted bool
	mulaw       []byte
	parser      mediastream.Parser
	turnCtx     context.Context
	turnSeq     uint64
	bgTurn      uint64
	readerDone  chan struct{}
}

var (
	_ voice.Transport          = (*Adapter)(nil)
	_ voice.Named              = (*Adapter)(nil)
	_ voice.ConnectionReporter = (*Adapter)(nil)
	_ voice.Interrupter        = (*Adapter)(nil)
	_ voice.TurnObserver       = (*Adapter)(nil)
)

// New returns an adapter; it validates the endpoint for the transport.
func New(opts Options) (*Adapter, error) {
	if opts.Transport == "" {
		opts.Transport = TransportWebSocket
	}
	switch opts.Transport {
	case TransportWebSocket:
		if opts.URL == "" {
			return nil, errors.New("PipecatAgentAdapter(transport='websocket') requires url=")
		}
	case TransportWebRTC:
		if opts.SignalingURL == "" {
			return nil, errors.New("PipecatAgentAdapter(transport='webrtc') requires signalingUrl=")
		}
	default:
		return nil, fmt.Errorf("PipecatAgentAdapter: unknown transport %q", opts.Transport)
	}
	if opts.AudioFormat == "" {
		opts.AudioFormat = "mulaw"
	}
	if opts.SampleRate == 0 {
		opts.SampleRate = mediastream.SampleRate
	}
	a := &Adapter{opts: opts, logger: opts.Logger}
	if a.logger == nil {
		a.logger = slog.Default()
	}
	if !opts.DisablePacing {
		a.sender.Interval = mediastream.FrameInterval
	}
	return a, nil
}

// Name implements voice.Named.
func (a *Adapter) Name() string { return Name }

// TransportFormat is "<audioFormat>/<sampleRate>", such as "mulaw/8000".
func (a *Adapter) TransportFormat() string {
	return a.opts.AudioFormat + "/" + strconv.Itoa(a.opts.SampleRate)
}

// Capabilities implements voice.Transport. Pipecat runs its own VAD, and a
// Twilio "clear" frame drops the bot's buffered audio (interruption).
func (a *Adapter) Capabilities() voice.Capabilities {
	return voice.Capabilities{
		StreamingTranscripts: true,
		NativeVAD:            true,
		Interruption:         true,
		InputFormats:         []string{"pcm16/24000", "mulaw/8000"},
		OutputFormats:        []string{"pcm16/24000", "mulaw/8000"},
	}
}

type mediaFormat struct {
	Encoding   string `json:"encoding"`
	SampleRate int    `json:"sampleRate"`
	Channels   int    `json:"channels"`
}

type startBody struct {
	StreamSID   string      `json:"streamSid"`
	CallSID     string      `json:"callSid"`
	MediaFormat mediaFormat `json:"mediaFormat"`
}

type startFrame struct {
	Event     string    `json:"event"`
	StreamSID string    `json:"streamSid"`
	Start     startBody `json:"start"`
}

// Connect implements voice.Transport: it dials the bot, performs the
// synthetic Twilio handshake the bot's serializer requires before media,
// and starts the background receive loop.
func (a *Adapter) Connect(ctx context.Context) error {
	if a.opts.Transport == TransportWebRTC {
		return &voice.PendingTransportError{Adapter: "PipecatAgentAdapter(transport='webrtc')"}
	}
	a.mu.Lock()
	connected := a.conn != nil
	a.mu.Unlock()
	if connected {
		return nil
	}
	ws, _, err := websocket.Dial(ctx, a.opts.URL, a.opts.DialOptions)
	if err != nil {
		return fmt.Errorf("PipecatAgentAdapter: connecting to %s: %w", a.opts.URL, err)
	}
	conn := mediastream.NewWSConn(ws)
	streamSID, callSID := a.opts.StreamSID, a.opts.CallSID
	if streamSID == "" {
		streamSID = "MZ" + randomHex()
	}
	if callSID == "" {
		callSID = "CA" + randomHex()
	}
	connectedFrame := []byte(`{"event":"connected","protocol":"Call","version":"1.0.0"}`)
	start, _ := json.Marshal(startFrame{Event: "start", StreamSID: streamSID, Start: startBody{
		StreamSID: streamSID, CallSID: callSID,
		MediaFormat: mediaFormat{Encoding: "audio/x-mulaw", SampleRate: mediastream.SampleRate, Channels: 1},
	}})
	for _, f := range [][]byte{connectedFrame, start} {
		if err := conn.WriteText(ctx, f); err != nil {
			conn.CloseNow()
			return fmt.Errorf("PipecatAgentAdapter: handshake: %w", err)
		}
	}

	a.mu.Lock()
	a.conn, a.streamSID, a.callSID = conn, streamSID, callSID
	a.closed, a.interrupted = false, false
	a.mulaw = a.mulaw[:0]
	a.readerDone = make(chan struct{})
	done := a.readerDone
	a.mu.Unlock()
	a.queue.Clear()
	go a.receiveLoop(conn, done)

	voice.SetSpanAttributes(trace.SpanFromContext(ctx),
		attribute.String("voice.pipecat.transport", a.opts.Transport),
		attribute.String("voice.pipecat.transport_format", a.TransportFormat()))
	return nil
}

func randomHex() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// IsConnected implements voice.ConnectionReporter.
func (a *Adapter) IsConnected() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.conn != nil
}

// Disconnect implements voice.Transport: a best-effort stop frame so the bot
// can clean up its pipeline, then the socket closes.
func (a *Adapter) Disconnect(ctx context.Context) error {
	a.mu.Lock()
	conn, sid, done := a.conn, a.streamSID, a.readerDone
	if conn == nil {
		a.mu.Unlock()
		return nil
	}
	a.conn, a.streamSID, a.callSID = nil, "", ""
	a.closed = true
	a.mu.Unlock()
	if sid != "" {
		_ = conn.WriteText(ctx, mediastream.AppendStopFrame(nil, sid))
	}
	a.queue.Fail(errors.New("PipecatAgentAdapter: disconnected while waiting for audio"))
	conn.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		conn.CloseNow()
		<-done
	}
	return nil
}

// SendAudio implements voice.Transport: 20 ms µ-law media frames, paced at
// real time, then an "utterance_end" mark so the bot need not guess the
// turn end from VAD timing. Concurrent sends are serialized so frames of
// two utterances never interleave.
func (a *Adapter) SendAudio(ctx context.Context, chunk voice.AudioChunk) error {
	a.mu.Lock()
	err := a.assertConnectedLocked()
	conn, sid := a.conn, a.streamSID
	// A new user turn ends the interruption of the previous one.
	a.interrupted = false
	a.mu.Unlock()
	if err != nil {
		return err
	}
	a.sendMu.Lock()
	defer a.sendMu.Unlock()
	if err := a.sender.Send(ctx, conn, sid, chunk.Data); err != nil {
		return err
	}
	return conn.WriteText(ctx, mediastream.AppendMarkFrame(nil, sid, "utterance_end"))
}

// ReceiveAudio implements voice.Transport. Right after an interruption it
// returns an empty end-of-turn chunk, so the drain records only the audio
// received before the barge-in.
func (a *Adapter) ReceiveAudio(ctx context.Context, timeout time.Duration) (voice.AudioChunk, error) {
	a.mu.Lock()
	if err := a.assertConnectedLocked(); err != nil {
		a.mu.Unlock()
		return voice.AudioChunk{}, err
	}
	if a.interrupted {
		a.interrupted = false
		a.mu.Unlock()
		return voice.AudioChunk{}, nil
	}
	closed := a.closed
	a.mu.Unlock()
	if closed && a.queue.Len() == 0 {
		return voice.AudioChunk{}, errors.New("PipecatAgentAdapter: socket closed, no audio available")
	}
	c, err := a.queue.Take(ctx, timeout)
	if errors.Is(err, mediastream.ErrTakeTimeout) {
		return c, fmt.Errorf("PipecatAgentAdapter: receiveAudio timed out after %vs: %w", timeout.Seconds(), voice.ErrReceiveTimeout)
	}
	return c, err
}

// Interrupt implements voice.Interrupter: a Twilio "clear" frame drops the
// bot's buffered audio, and the local receive side is truncated: queued and
// partially coalesced audio is discarded, a waiting receive gets an empty
// chunk, and late frames are dropped until the next SendAudio.
func (a *Adapter) Interrupt(ctx context.Context) error {
	a.mu.Lock()
	err := a.assertConnectedLocked()
	conn, sid := a.conn, a.streamSID
	a.mu.Unlock()
	if err != nil {
		return err
	}
	if err := conn.WriteText(ctx, mediastream.AppendClearFrame(nil, sid)); err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.queue.Clear()
	a.queue.Wake(voice.AudioChunk{})
	a.mulaw = a.mulaw[:0]
	a.interrupted = true
	return nil
}

// BeginTurn implements voice.TurnObserver.
func (a *Adapter) BeginTurn(ctx context.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.turnCtx = ctx
	a.turnSeq++
}

// EndTurn implements voice.TurnObserver.
func (a *Adapter) EndTurn() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.turnCtx = nil
}

func (a *Adapter) assertConnectedLocked() error {
	if a.conn == nil || a.streamSID == "" {
		return errors.New("PipecatAgentAdapter: not connected. Did you forget to call connect()?")
	}
	return nil
}

// receiveLoop reads the bot's frames until the socket closes, then flushes
// the partial batch and fails parked receives.
func (a *Adapter) receiveLoop(conn *mediastream.WSConn, done chan struct{}) {
	defer close(done)
	for {
		data, binary, err := conn.ReadFrame(context.Background())
		if err != nil {
			a.mu.Lock()
			if a.conn == conn || a.conn == nil {
				a.flushLocked()
				a.closed = true
			}
			a.mu.Unlock()
			a.queue.FailWaiters(errors.New("PipecatAgentAdapter: socket closed"))
			return
		}
		a.onMessage(data, binary)
	}
}

// onMessage handles one frame. A binary frame that does not look like JSON
// is raw µ-law (some bot configurations send audio outside the JSON
// wrapper).
func (a *Adapter) onMessage(data []byte, binary bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.conn == nil {
		return
	}
	if binary && (len(data) == 0 || (data[0] != '{' && data[0] != '[')) {
		a.bufferLocked(data)
		return
	}
	f, ok := a.parser.Parse(data)
	if !ok {
		return
	}
	switch f.Event {
	case mediastream.EventMedia:
		a.bufferLocked(f.Payload)
	case mediastream.EventStop:
		a.flushLocked()
	}
}

func (a *Adapter) bufferLocked(mulaw []byte) {
	if len(mulaw) == 0 || a.interrupted {
		// Frames of a just-interrupted bot turn must not pollute the next
		// turn's drain.
		return
	}
	a.mulaw = append(a.mulaw, mulaw...)
	if len(a.mulaw) >= mediastream.BatchBytes {
		a.flushLocked()
	}
}

// flushLocked decodes the coalesced µ-law into one canonical chunk and
// queues it. The first delivery under a live turn is wrapped in a
// voice.audio.receive span parented to that turn; later deliveries of the
// same turn, and deliveries between turns, are not spanned.
func (a *Adapter) flushLocked() {
	if len(a.mulaw) == 0 {
		return
	}
	pcm := audio.AppendPCM24kFromMulaw8k(make([]byte, 0, 6*len(a.mulaw)+2), a.mulaw)
	a.mulaw = a.mulaw[:0]
	if a.turnCtx != nil && a.turnSeq != a.bgTurn {
		a.bgTurn = a.turnSeq
		_, span := voice.StartSpan(a.turnCtx, voice.SpanAudioReceive,
			attribute.String("voice.adapter.class", Name),
			attribute.String("voice.pipecat.recv.source", "background_loop"),
			attribute.Int("voice.audio.bytes", len(pcm)))
		voice.EndSpan(span, nil)
	}
	a.queue.Put(voice.AudioChunk{Data: pcm})
}
