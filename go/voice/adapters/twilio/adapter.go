// Package twilio is the real-phone voice transport over Twilio Media
// Streams, a port of the JavaScript SDK's TwilioAgentAdapter.
//
// The adapter speaks the Media Streams protocol (µ-law 8 kHz JSON frames
// over a WebSocket) and plugs into the voice runtime as a [voice.Transport]
// (wrap it with voice.NewAgent). It runs in one of two modes:
//
//   - SDK-owned (convenience) mode, [New]: Connect starts a local webhook and
//     media-stream server and exposes it on PublicBaseURL (or a tunnel).
//     PlaceCall originates an outbound call over Twilio REST; WaitForCall
//     answers an inbound one. A-leg calls (the stream on our own leg, any
//     external number) are guarded by a per-call stream nonce, a destination
//     allowlist, an edge-readiness probe and a call-duration cap.
//   - Embedded mode, [NewStream]: the adapter runs over a media-stream
//     WebSocket an embedder already accepted (a server-side runner with its
//     own listener). There is no SDK-owned server, no tunnel and no REST
//     dialing. [AcceptConn] completes the WebSocket handshake on a raw
//     net.Conn first, for embedders that hand over a hijacked or
//     process-transferred connection.
//
// Inbound audio passes an energy gate ([vad.SpeechGate]) before it is
// queued: a phone line delivers a frame every 20 ms, silence included, and
// the gate is what lets the runtime's tail-silence turn end fire.
package twilio

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/internal/mediastream"
	"github.com/langwatch/scenario/go/voice/tunnel"
	"github.com/langwatch/scenario/go/voice/vad"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// Name is the adapter name reported in spans and errors (the JavaScript
// SDK's class name).
const Name = "TwilioAgentAdapter"

// ALegSendDTMFUnsupported is the refusal of SendDTMF on an a-leg call.
const ALegSendDTMFUnsupported = "TwilioAgentAdapter: sendDtmf is unsupported in external (a-leg) mode. " +
	"Sending DTMF replaces the live call's TwiML, which redirects the call away " +
	"from the <Connect><Stream> verb and would end the media stream this " +
	"scenario is running on. In b-leg mode the stream rides the callee's leg, " +
	"so the redirect is harmless; in a-leg mode it is the call. Use b-leg mode " +
	"(an owned callee number) if the scenario needs DTMF."

// ErrStreamConnectTimeout is wrapped by the error of a dial (or an embedded
// Connect) whose media stream did not connect in time.
var ErrStreamConnectTimeout = errors.New("twilio: the media stream did not connect in time")

// EndedReason is how the most recent media session ended.
type EndedReason string

// The media session end reasons, stamped as voice.twilio.stream_ended_reason.
const (
	// EndedNone: no session has ended since the last (re)connect or dial.
	EndedNone EndedReason = "none"
	// EndedStop: Twilio sent a stop frame.
	EndedStop EndedReason = "stop"
	// EndedClose: the socket closed without a stop frame.
	EndedClose EndedReason = "close"
	// EndedError: the socket failed.
	EndedError EndedReason = "error"
	// EndedMaxDuration: the a-leg duration cap hung the call up. It wins over
	// the close that follows, so "we hung up at the cap" stays distinguishable
	// from "the callee hung up".
	EndedMaxDuration EndedReason = "max_duration"
)

type mode string

const (
	modeIdle   mode = "idle"
	modeAnswer mode = "answer"
	modeCall   mode = "call"
)

// MediaOptions configure the media stream, in both modes.
type MediaOptions struct {
	// OnDTMF is called with each DTMF digit the far end sends. A panic in it
	// is logged and does not tear the stream down.
	OnDTMF func(digit string)
	// SpeechGate tunes the inbound energy gate (zero values: the measured
	// phone-line defaults).
	SpeechGate vad.GateOptions
	// DisableSpeechGate admits every inbound frame. Only sensible for a far
	// end that stops sending during silence: otherwise the agent's turn ends
	// only on hangup or the drain's hard ceiling.
	DisableSpeechGate bool
	// Logger receives operational signals (rejected webhooks and sockets,
	// DTMF, the duration cap). Default slog.Default().
	Logger *slog.Logger
}

// Options configure an SDK-owned (convenience mode) adapter.
type Options struct {
	AccountSID string
	AuthToken  string
	// PhoneNumber is the Twilio-owned number, E.164 ("+14155551234").
	PhoneNumber string
	// PublicBaseURL is the HTTPS URL routing to the local server. Required at
	// Connect unless Tunnel is set.
	PublicBaseURL string
	// Tunnel, when PublicBaseURL is empty, is opened against the local server
	// at Connect (and closed at Disconnect); its URL becomes the public base
	// URL. A tunnel implementing tunnel.Readiness also serves as
	// TunnelReadiness when that is unset.
	Tunnel tunnel.Provider
	// AllowedCallers filters inbound callers; empty accepts any caller.
	AllowedCallers []string
	// AllowedCallees is the a-leg destination allowlist. Empty denies every
	// a-leg destination: a-leg dials numbers this account does not own, so
	// each one must be opted into. Entries are validated by New. B-leg is not
	// gated on it: it can only reach numbers on this account.
	AllowedCallees []string
	// TunnelReadiness is consulted before a-leg origination. Unset means the
	// public URL is stable and there is nothing to wait for.
	TunnelReadiness TunnelReadiness
	// HTTPPort binds the local server; 0 picks a free port.
	HTTPPort int
	// SkipSignatureValidation accepts inbound webhooks without a valid
	// X-Twilio-Signature. Tests only; production must validate.
	SkipSignatureValidation bool
	// HTTPClient and RESTBaseURL configure the default REST client.
	HTTPClient  *http.Client
	RESTBaseURL string
	// REST replaces the REST client built from AccountSID and AuthToken.
	REST REST
	MediaOptions
}

// StreamOptions configure an embedded adapter.
type StreamOptions struct {
	MediaOptions
	// StreamNonce, when set, must be presented by the start frame's "nonce"
	// custom parameter (a-leg authentication); a socket that cannot is
	// closed. Leave it empty when the embedder authenticated the socket.
	StreamNonce string
	// CallSID, when set, must match the start frame's callSid. It is also the
	// call DTMF is sent on.
	CallSID string
	// ConnectTimeout bounds Connect's wait for the start frame; default
	// DefaultStreamConnectTimeout.
	ConnectTimeout time.Duration
	// REST, with CallSID, lets SendDTMF play tones on the call. Without it
	// the adapter does not advertise DTMF.
	REST REST
}

// embedded is the connection an embedded adapter runs over.
type embedded struct {
	conn    mediastream.Conn
	timeout time.Duration
	nonce   string
	callSID string
}

// Adapter is the Twilio Media Streams transport. Create it with [New] or
// [NewStream]; it is safe for concurrent use.
type Adapter struct {
	// Configuration, fixed after construction.
	accountSID, authToken, phoneNumber string
	allowedCallers                     map[string]struct{}
	allowedCallees                     map[string]struct{}
	readiness                          TunnelReadiness
	tunnelProvider                     tunnel.Provider
	httpPort                           int
	validateSignature                  bool
	httpClient                         *http.Client
	restBaseURL                        string
	restOverride                       REST
	onDTMF                             func(string)
	logger                             *slog.Logger
	embed                              *embedded

	// awaitMaxDuration waits out the a-leg duration cap; a test seam.
	awaitMaxDuration func(ctx context.Context, d time.Duration) error

	queue mediastream.Queue

	sendMu sync.Mutex
	sender mediastream.Sender

	mu             sync.Mutex
	connected      bool
	sessionCtx     context.Context
	sessionCancel  context.CancelFunc
	sessions       map[mediastream.Conn]chan struct{}
	rest           REST
	server         *webhookServer
	tun            tunnel.Tunnel
	activeReady    TunnelReadiness
	publicBaseURL  string
	phoneNumberSID string
	priorVoiceURL  string
	calleeSID      string
	priorCallee    string
	mode           mode
	streamConn     mediastream.Conn
	streamSID      string
	callSID        string
	// callGeneration is bumped on every (re)connect and dial. A media loop
	// captures it when it adopts its socket; once it moves, that socket is
	// stale and is closed on its next frame instead of touching the call.
	callGeneration int
	// streamNonce arms a-leg start-frame authentication; "" in every other
	// mode, whose sockets inherit the signed webhook's trust.
	streamNonce string
	// maxDurGen cancels a superseded duration watchdog.
	maxDurGen       int
	maxDurCancel    context.CancelFunc
	streamConnected *signal
	gate            *vad.SpeechGate
	admitted        []audio.Chunk
	// streamEnded is set when the media session ends; ReceiveAudio then
	// drains the queue and synthesizes end-of-turn chunks without asserting
	// liveness.
	streamEnded     bool
	sawLiveStream   bool
	localDisconnect bool
	agentHungUp     bool
	framesReceived  int
	dtmfReceived    int
	endedReason     EndedReason
	webhookCalls    int
	rejected        int
	turnCtx         context.Context
	turnSeq         uint64
}

var (
	_ voice.Transport          = (*Adapter)(nil)
	_ voice.Named              = (*Adapter)(nil)
	_ voice.ConnectionReporter = (*Adapter)(nil)
	_ voice.HangupReporter     = (*Adapter)(nil)
	_ voice.DTMFSender         = (*Adapter)(nil)
	_ voice.Interrupter        = (*Adapter)(nil)
	_ voice.TurnObserver       = (*Adapter)(nil)
)

// New returns an SDK-owned adapter. It validates the phone number and the
// callee allowlist; nothing touches the network before Connect.
func New(opts Options) (*Adapter, error) {
	if err := ValidateE164(opts.PhoneNumber); err != nil {
		return nil, err
	}
	a := newAdapter(opts.MediaOptions)
	a.accountSID, a.authToken, a.phoneNumber = opts.AccountSID, opts.AuthToken, opts.PhoneNumber
	a.publicBaseURL = opts.PublicBaseURL
	a.tunnelProvider = opts.Tunnel
	a.readiness = opts.TunnelReadiness
	a.httpPort = opts.HTTPPort
	a.validateSignature = !opts.SkipSignatureValidation
	a.httpClient, a.restBaseURL, a.restOverride = opts.HTTPClient, opts.RESTBaseURL, opts.REST
	if len(opts.AllowedCallers) > 0 {
		a.allowedCallers = make(map[string]struct{}, len(opts.AllowedCallers))
		for _, c := range opts.AllowedCallers {
			a.allowedCallers[c] = struct{}{}
		}
	}
	if len(opts.AllowedCallees) > 0 {
		a.allowedCallees = make(map[string]struct{}, len(opts.AllowedCallees))
		for _, c := range opts.AllowedCallees {
			n, err := NormalizeE164(c)
			if err != nil {
				return nil, err
			}
			a.allowedCallees[n] = struct{}{}
		}
	}
	return a, nil
}

// NewStream returns an embedded adapter over a media-stream WebSocket the
// caller already accepted (for example with websocket.Accept in its own
// handler, or with [AcceptConn] on a raw connection). The adapter owns ws
// from here on: Connect starts reading it and waits for Twilio's start
// frame, Disconnect closes it. An embedded adapter serves one call.
func NewStream(ws *websocket.Conn, opts StreamOptions) *Adapter {
	return newStream(mediastream.NewWSConn(ws), opts)
}

func newStream(conn mediastream.Conn, opts StreamOptions) *Adapter {
	a := newAdapter(opts.MediaOptions)
	timeout := opts.ConnectTimeout
	if timeout <= 0 {
		timeout = DefaultStreamConnectTimeout
	}
	a.embed = &embedded{conn: conn, timeout: timeout, nonce: opts.StreamNonce, callSID: opts.CallSID}
	a.restOverride = opts.REST
	return a
}

func newAdapter(m MediaOptions) *Adapter {
	a := &Adapter{
		onDTMF:           m.OnDTMF,
		logger:           m.Logger,
		awaitMaxDuration: sleepCtx,
		mode:             modeIdle,
		endedReason:      EndedNone,
		streamConnected:  newSignal(),
	}
	a.sender.Interval = mediastream.FrameInterval
	if a.logger == nil {
		a.logger = slog.Default()
	}
	if !m.DisableSpeechGate {
		a.gate = vad.NewSpeechGate(m.SpeechGate)
	}
	return a
}

// Name implements voice.Named.
func (a *Adapter) Name() string { return Name }

// Capabilities implements voice.Transport: µ-law 8 kHz both ways, Twilio
// "clear" interruption, DTMF over REST.
func (a *Adapter) Capabilities() voice.Capabilities {
	return voice.Capabilities{
		DTMF:          a.embed == nil || a.restOverride != nil,
		Interruption:  true,
		InputFormats:  []string{"mulaw/8000"},
		OutputFormats: []string{"mulaw/8000"},
	}
}

// Connect implements voice.Transport. It is idempotent.
//
// SDK-owned mode resolves the number's SID over REST, starts the local
// server and, without a PublicBaseURL, opens the tunnel; it is
// direction-agnostic: call PlaceCall or WaitForCall next. Embedded mode
// starts reading the media stream and waits for its start frame.
func (a *Adapter) Connect(ctx context.Context) error {
	if a.embed != nil {
		return a.connectEmbedded(ctx)
	}
	a.mu.Lock()
	if a.connected {
		a.mu.Unlock()
		return nil
	}
	base := a.publicBaseURL
	a.mu.Unlock()
	if base == "" && a.tunnelProvider == nil {
		return errors.New("TwilioAgentAdapter: publicBaseUrl is required. Set Options.Tunnel or " +
			"supply a stable public HTTPS URL routing to this machine.")
	}
	rest := a.restOverride
	if rest == nil {
		rest = &RESTClient{AccountSID: a.accountSID, AuthToken: a.authToken, HTTPClient: a.httpClient, BaseURL: a.restBaseURL}
	}
	sid, err := rest.ResolvePhoneNumberSID(ctx, a.phoneNumber)
	if err != nil {
		return err
	}
	// The adapter contributes attributes to the runtime's connect span. No
	// direction here: Connect is direction-agnostic; the dial span has it.
	voice.SetSpanAttributes(trace.SpanFromContext(ctx),
		attribute.String("voice.twilio.phone_number_sid", sid),
		attribute.Bool("voice.twilio.validate_signature", a.validateSignature),
		attribute.Int("voice.twilio.webhook_port", a.httpPort))

	srv, err := startServer(a, a.httpPort)
	if err != nil {
		return err
	}
	var tun tunnel.Tunnel
	ready := a.readiness
	if base == "" {
		if tun, err = a.tunnelProvider.Open(ctx, srv.port); err != nil {
			srv.stop()
			return fmt.Errorf("TwilioAgentAdapter: opening the tunnel: %w", err)
		}
		base = tun.URL()
		if r, ok := tun.(tunnel.Readiness); ok && ready == nil {
			ready = r
		}
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	a.resetForConnectionLocked()
	a.rest, a.phoneNumberSID, a.server, a.tun, a.activeReady = rest, sid, srv, tun, ready
	a.publicBaseURL = base
	a.sessionCtx, a.sessionCancel = context.WithCancel(context.Background())
	a.connected = true
	return nil
}

func (a *Adapter) connectEmbedded(ctx context.Context) error {
	a.mu.Lock()
	if a.connected {
		a.mu.Unlock()
		return nil
	}
	a.resetForConnectionLocked()
	a.rest = a.restOverride
	a.streamNonce, a.callSID = a.embed.nonce, a.embed.callSID
	a.sessionCtx, a.sessionCancel = context.WithCancel(context.Background())
	a.connected = true
	sig := a.streamConnected
	a.mu.Unlock()

	go func() {
		// The adapter owns the socket: it is closed however the stream
		// ended, as the SDK-owned server closes the ones it accepts. A stream
		// ended by a stop frame is no longer a live session Disconnect would
		// close.
		defer a.embed.conn.Close()
		if err := a.runStreamSession(a.embed.conn); err != nil {
			a.logger.Warn("twilio: media stream failed", "error", err)
		}
	}()
	if err := waitSignal(ctx, sig, a.embed.timeout); err != nil {
		return fmt.Errorf("TwilioAgentAdapter: waiting for the media stream's start frame: %w", err)
	}
	a.mu.Lock()
	callSID := a.callSID
	a.mu.Unlock()
	voice.SetSpanAttributes(trace.SpanFromContext(ctx), attribute.String("voice.twilio.call_sid", callSID))
	return nil
}

// resetForConnectionLocked starts a fresh connection lifecycle.
func (a *Adapter) resetForConnectionLocked() {
	a.mode = modeIdle
	a.streamNonce = ""
	a.cancelMaxDurationLocked()
	// A socket left from a previous connection can never pass the media
	// loop's ownership check again.
	a.callGeneration++
	a.streamConnected = newSignal()
	a.queue.Fail(errStreamReset)
	if a.gate != nil {
		a.gate.ResetCounters()
	}
	a.streamEnded, a.sawLiveStream, a.localDisconnect, a.agentHungUp = false, false, false, false
	a.framesReceived, a.dtmfReceived, a.webhookCalls, a.rejected = 0, 0, 0, 0
	a.endedReason = EndedNone
}

// IsConnected implements voice.ConnectionReporter. It turns false once the
// media session ended (a remote hangup trips it on its own), except while
// audio recorded before the hangup is still queued, so the last turn drains
// the farewell instead of concluding without it.
func (a *Adapter) IsConnected() bool {
	a.mu.Lock()
	connected, ended := a.connected, a.streamEnded
	a.mu.Unlock()
	return connected && (!ended || a.queue.HasAudio())
}

// AgentHungUp implements voice.HangupReporter: the far end ended a live
// stream (stop or close) that this adapter did not tear down itself.
func (a *Adapter) AgentHungUp() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.agentHungUp
}

// Disconnect implements voice.Transport. It restores the voice URLs it
// rewrote, closes the server, every media session and the tunnel, then
// stamps the call-lifetime counters on the runtime's disconnect span.
func (a *Adapter) Disconnect(ctx context.Context) error {
	a.mu.Lock()
	if !a.connected {
		a.mu.Unlock()
		return nil
	}
	// Mark the teardown as ours before closing anything, so the close it
	// causes is not read as the far end hanging up.
	a.localDisconnect = true
	// From here on the call is ours to end: a watchdog firing mid-teardown
	// could hang up a later call's SID.
	a.cancelMaxDurationLocked()
	md, rest := a.mode, a.rest
	phoneSID, prior, calleeSID, priorCallee := a.phoneNumberSID, a.priorVoiceURL, a.calleeSID, a.priorCallee
	srv, tun := a.server, a.tun
	a.mu.Unlock()

	restoreFailed := false
	if md == modeAnswer && phoneSID != "" && rest != nil {
		if err := rest.WriteVoiceURL(ctx, phoneSID, prior); err != nil {
			restoreFailed = true
		}
	}
	if md == modeCall && calleeSID != "" && rest != nil {
		if err := rest.WriteVoiceURL(ctx, calleeSID, priorCallee); err != nil {
			restoreFailed = true
		}
	}
	if srv != nil {
		srv.stop()
	}
	// Closing the live sessions is what lets their loops make their final
	// counter writes, so the stamp below runs after it.
	a.closeSessions()
	if tun != nil {
		_ = tun.Close()
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	attrs := []attribute.KeyValue{
		attribute.Int("voice.twilio.frames_received", a.framesReceived),
		attribute.Int("voice.twilio.dtmf_received", a.dtmfReceived),
		attribute.String("voice.twilio.stream_ended_reason", string(a.endedReason)),
		attribute.Int("voice.twilio.webhook_invocations", a.webhookCalls),
		attribute.Int("voice.twilio.webhook_rejected", a.rejected),
		attribute.Bool("voice.twilio.rest_restore_failed", restoreFailed),
		attribute.Bool("voice.twilio.speech_gate.enabled", a.gate != nil),
	}
	dropped, droppedMs, onsets := 0, 0.0, 0
	if a.gate != nil {
		dropped, droppedMs, onsets = a.gate.DroppedChunks, a.gate.DroppedMs, a.gate.Onsets
	}
	attrs = append(attrs,
		attribute.Int("voice.twilio.speech_gate.dropped_chunks", dropped),
		attribute.Int64("voice.twilio.speech_gate.dropped_ms", int64(math.Round(droppedMs))),
		attribute.Int("voice.twilio.speech_gate.onsets", onsets))
	voice.SetSpanAttributes(trace.SpanFromContext(ctx), attrs...)

	a.resetForConnectionLocked()
	if a.sessionCancel != nil {
		a.sessionCancel()
	}
	a.connected = false
	a.server, a.tun, a.activeReady = nil, nil, nil
	if a.embed == nil && a.tunnelProvider != nil {
		a.publicBaseURL = ""
	}
	a.rest = nil
	a.phoneNumberSID, a.priorVoiceURL, a.calleeSID, a.priorCallee = "", "", "", ""
	a.streamConn, a.streamSID, a.callSID = nil, "", ""
	return nil
}

// closeSessions closes every live media session and waits for its loop to
// finish. A peer that does not answer the close handshake within a second
// has its reads cancelled, which drops the connection.
func (a *Adapter) closeSessions() {
	a.mu.Lock()
	live := make([]chan struct{}, 0, len(a.sessions))
	for c, done := range a.sessions {
		c.Close()
		live = append(live, done)
	}
	cancel := a.sessionCancel
	a.mu.Unlock()
	if len(live) == 0 {
		return
	}
	grace := time.After(time.Second)
	forced := false
	for _, done := range live {
		if !forced {
			select {
			case <-done:
				continue
			case <-grace:
			}
			if cancel != nil {
				cancel()
			}
			forced = true
		}
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			a.logger.Warn("twilio: a media session did not end after its socket was closed")
		}
	}
}

// SendAudio implements voice.Transport: the chunk leaves as 20 ms µ-law
// media frames paced at real time. Once the stream ended it is a no-op:
// there is nobody left to hear it.
func (a *Adapter) SendAudio(ctx context.Context, chunk voice.AudioChunk) error {
	a.mu.Lock()
	if a.streamEnded {
		a.mu.Unlock()
		return nil
	}
	err := a.assertStreamLiveLocked()
	conn, sid := a.streamConn, a.streamSID
	a.mu.Unlock()
	if err != nil {
		return err
	}
	a.sendMu.Lock()
	defer a.sendMu.Unlock()
	if err := a.sender.Send(ctx, conn, sid, chunk.Data); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		// The socket went away mid-utterance: the media loop reports the
		// hangup, the next turn concludes on it.
		a.logger.Debug("twilio: media stream closed while sending audio", "error", err)
	}
	return nil
}

// ReceiveAudio implements voice.Transport. Buffered audio (or the end-of-
// call chunk the media loop queued) is drained whether or not the stream is
// still live; once the call ended and the queue is empty, every call returns
// an empty end-of-turn chunk.
func (a *Adapter) ReceiveAudio(ctx context.Context, timeout time.Duration) (voice.AudioChunk, error) {
	if a.queue.Len() == 0 {
		a.mu.Lock()
		ended := a.streamEnded
		err := a.assertStreamLiveLocked()
		a.mu.Unlock()
		if ended {
			return voice.AudioChunk{}, nil
		}
		if err != nil {
			return voice.AudioChunk{}, err
		}
	}
	c, err := a.queue.Take(ctx, timeout)
	if errors.Is(err, mediastream.ErrTakeTimeout) {
		return c, fmt.Errorf("TwilioAgentAdapter: no audio received within %dms: %w", timeout.Milliseconds(), voice.ErrReceiveTimeout)
	}
	return c, err
}

var errStreamReset = errors.New("TwilioAgentAdapter: stream reset before audio arrived.")

// SendDTMF implements voice.DTMFSender over REST (<Play digits>). It is
// refused on an a-leg call: replacing that call's TwiML would redirect it
// away from the <Connect><Stream> carrying the scenario.
func (a *Adapter) SendDTMF(ctx context.Context, tones string) error {
	a.mu.Lock()
	nonce, rest, callSID := a.streamNonce, a.rest, a.callSID
	a.mu.Unlock()
	if nonce != "" && a.embed == nil {
		return errors.New(ALegSendDTMFUnsupported)
	}
	if rest == nil || callSID == "" {
		return errors.New("TwilioAgentAdapter: no active call; sendDtmf requires an in-progress call.")
	}
	return rest.SendDTMF(ctx, callSID, tones)
}

// Interrupt implements voice.Interrupter: a Twilio "clear" frame drops the
// far end's buffered outbound audio.
func (a *Adapter) Interrupt(ctx context.Context) error {
	a.mu.Lock()
	err := a.assertStreamLiveLocked()
	conn, sid := a.streamConn, a.streamSID
	a.mu.Unlock()
	if err != nil {
		return err
	}
	return conn.WriteText(ctx, mediastream.AppendClearFrame(nil, sid))
}

// BeginTurn implements voice.TurnObserver: the media loop parents its
// background receive span under the live turn.
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

// CallSID is the Twilio SID of the current or last call, once known.
func (a *Adapter) CallSID() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.callSID
}

// PublicBaseURL is the public URL Twilio reaches this adapter on.
func (a *Adapter) PublicBaseURL() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.publicBaseURL
}

// LocalBaseURL is the bound local server, such as http://127.0.0.1:54321.
func (a *Adapter) LocalBaseURL() (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.server == nil {
		return "", errors.New("TwilioAgentAdapter: not connected; localBaseUrl unavailable.")
	}
	return a.server.baseURL(), nil
}

func (a *Adapter) assertConnectedLocked() error {
	if !a.connected {
		return errors.New("TwilioAgentAdapter: not connected; call connect() first.")
	}
	return nil
}

func (a *Adapter) assertStreamLiveLocked() error {
	if err := a.assertConnectedLocked(); err != nil {
		return err
	}
	if a.streamConn == nil || a.streamSID == "" {
		return errors.New("TwilioAgentAdapter: no live media stream. Call placeCall() or waitForCall() first.")
	}
	return nil
}

// signal is a one-shot event.
type signal struct {
	once sync.Once
	ch   chan struct{}
}

func newSignal() *signal { return &signal{ch: make(chan struct{})} }

func (s *signal) fire() { s.once.Do(func() { close(s.ch) }) }

// waitSignal waits for s, up to timeout.
func waitSignal(ctx context.Context, s *signal, timeout time.Duration) error {
	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case <-s.ch:
		return nil
	case <-t.C:
		return fmt.Errorf("TwilioAgentAdapter: timed out after %dms: %w", timeout.Milliseconds(), ErrStreamConnectTimeout)
	case <-ctx.Done():
		return ctx.Err()
	}
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
