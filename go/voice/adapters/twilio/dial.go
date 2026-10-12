package twilio

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/langwatch/scenario/go/voice"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// SpanAdapterDial wraps PlaceCall and WaitForCall: the REST dial and the
// wait for the media stream, the "I placed the call but no media ever
// streamed" failure surface.
const SpanAdapterDial = "voice.adapter.dial"

// StreamAttach is where an outbound call's media stream attaches.
type StreamAttach string

const (
	// AttachBLeg (default) rewrites the callee's voice URL so its webhook
	// streams to us: owned callee numbers only.
	AttachBLeg StreamAttach = "b-leg"
	// AttachALeg originates with inline <Connect><Stream>, so the stream
	// rides our own leg and the callee can be any external number. The
	// callee must be in AllowedCallees and the public URL reachable from the
	// edge; the call is capped by MaxCallDuration.
	AttachALeg StreamAttach = "a-leg"
	// AttachOriginatorOnly places the call and does not wait for a stream to
	// reach us: the callee owns it.
	AttachOriginatorOnly StreamAttach = "originator-only"
)

// aLegHoldSay is spoken by the originating leg while the callee's webhook
// attaches the stream: a deterministic anchor, since speech-to-text
// hallucinates on bare silence.
const aLegHoldSay = "Thank you for calling. I will hold the line while you complete your scenario."

// CallOptions configure PlaceCall.
type CallOptions struct {
	// To is the destination, E.164.
	To string
	// Attach selects the stream mode; default AttachBLeg.
	Attach StreamAttach
	// Timeout bounds the wait for the media stream to connect (ring time
	// included); default DefaultStreamConnectTimeout.
	Timeout time.Duration
	// MaxCallDuration caps an a-leg call (default DefaultMaxCallDuration,
	// at most MaxCallDurationCap). Under <Connect> the call lives as long
	// as the socket, so it is enforced twice: Twilio's TimeLimit (which
	// survives this process dying) and a local watchdog that hangs up over
	// REST and closes the socket. Other modes reject it: their <Pause> hold
	// already bounds them.
	MaxCallDuration time.Duration
	// Record asks Twilio to record the call.
	Record bool
	// StreamNonce overrides the a-leg nonce this adapter would mint, for a
	// host platform whose media listener runs in another process and must
	// register the nonce before Twilio can connect. Ignored outside a-leg.
	StreamNonce string
}

// PlaceCall originates an outbound call and, unless the stream is the
// callee's, waits for its media stream to connect.
func (a *Adapter) PlaceCall(ctx context.Context, opts CallOptions) error {
	a.mu.Lock()
	err := a.dialPreconditionsLocked(modeCall)
	rest, base := a.rest, a.publicBaseURL
	a.mu.Unlock()
	if err != nil {
		return err
	}
	if err := ValidateE164(opts.To); err != nil {
		return err
	}
	attach := opts.Attach
	if attach == "" {
		attach = AttachBLeg
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = DefaultStreamConnectTimeout
	}
	// Only a-leg loses <Pause>'s implicit ceiling, so only a-leg takes a
	// duration; naming one elsewhere would leave the caller believing the
	// call is bounded by it.
	timeLimit := 0
	switch attach {
	case AttachALeg:
		// The free local checks run first: a misconfigured allowlist costs
		// nothing and dials nothing.
		if err := a.assertCalleeAllowed(opts.To); err != nil {
			return err
		}
		if timeLimit, err = ResolveMaxCallDuration(opts.MaxCallDuration); err != nil {
			return err
		}
		if err := a.assertTunnelReady(ctx); err != nil {
			return err
		}
	case AttachBLeg, AttachOriginatorOnly:
		if opts.MaxCallDuration != 0 {
			//lint:ignore ST1005 same message as the JS SDK's Twilio adapter
			return errors.New(`placeCall: maxCallDuration is only supported with attachStream="a-leg"; ` +
				`b-leg and originator-only modes hold the originator leg with <Pause> and are bounded by it.`)
		}
	default:
		return fmt.Errorf("placeCall: unknown stream attach mode %q", attach)
	}

	ctx, span := voice.StartSpan(ctx, SpanAdapterDial,
		attribute.String("voice.adapter.class", Name),
		attribute.String("voice.twilio.direction", "outbound"),
		attribute.String("voice.twilio.to", RedactE164(opts.To)),
		attribute.String("voice.twilio.from", RedactE164(a.phoneNumber)))
	err = a.dialOut(ctx, span, rest, base, attach, timeLimit, opts, timeout)
	voice.EndSpan(span, err)
	return err
}

func (a *Adapter) dialOut(ctx context.Context, span trace.Span, rest REST, base string,
	attach StreamAttach, timeLimit int, opts CallOptions, timeout time.Duration) error {
	// Evict any socket adopted before this dial and start its state clean,
	// so a stale socket can neither resolve the wait below nor feed the call.
	a.resetConnectionStateForDial()
	if attach == AttachBLeg {
		sid, err := rest.ResolvePhoneNumberSID(ctx, opts.To)
		if err != nil {
			return err
		}
		if err := a.savePriorCalleeURL(ctx, rest, sid); err != nil {
			return err
		}
		if err := rest.WriteVoiceURL(ctx, sid, strings.TrimSuffix(base, "/")+"/twilio/voice"); err != nil {
			return err
		}
	}

	// A-leg: the socket is the only inbound signal, so it authenticates with
	// a per-call nonce Twilio echoes back in the start frame. Other modes hold
	// the originating leg while the callee's webhook attaches the stream.
	nonce := ""
	if attach == AttachALeg {
		nonce = opts.StreamNonce
		if nonce == "" {
			nonce = MintStreamNonce()
		}
	}
	a.mu.Lock()
	a.streamNonce = nonce
	a.mu.Unlock()
	var twiml string
	if nonce != "" {
		twiml = connectStreamTwiML(StreamWSURL(base, nonce), nonce)
	} else {
		twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">` + aLegHoldSay +
			`</Say><Pause length="120"/></Response>`
	}
	callSID, err := rest.PlaceCall(ctx, PlaceCallParams{To: opts.To, From: a.phoneNumber, TwiML: twiml,
		TimeLimitSeconds: timeLimit, Record: opts.Record})
	if err != nil {
		return err
	}
	a.mu.Lock()
	a.callSID = callSID
	sig := a.streamConnected
	a.mu.Unlock()
	voice.SetSpanAttributes(span, attribute.String("voice.twilio.call_sid", callSID))
	if opts.Record {
		voice.SetSpanAttributes(span, attribute.Bool("voice.twilio.record", true))
	}
	if timeLimit > 0 {
		a.armMaxDurationTimer(time.Duration(timeLimit)*time.Second, callSID, opts.To)
	}
	if attach == AttachOriginatorOnly {
		return nil
	}
	started := time.Now()
	if err := waitSignal(ctx, sig, timeout); err != nil {
		if errors.Is(err, ErrStreamConnectTimeout) {
			voice.SetSpanAttributes(span, attribute.String("voice.twilio.dial_outcome", "stream_connect_timeout"))
			if attach == AttachALeg {
				// Under <Connect> the originated call lives to the cap even
				// though nothing will stream on it: hang it up now.
				a.abandonOriginatedCall(callSID)
			}
		}
		return err
	}
	voice.SetSpanAttributes(span, attribute.Int64("voice.twilio.stream_connect_latency_ms", time.Since(started).Milliseconds()))
	return nil
}

// savePriorCalleeURL records a b-leg callee's voice URL before its first
// rewrite. A later PlaceCall to the same number would read back our own
// webhook, so only the first read per number SID is kept.
func (a *Adapter) savePriorCalleeURL(ctx context.Context, rest REST, sid string) error {
	a.mu.Lock()
	_, saved := a.priorCallees[sid]
	a.mu.Unlock()
	if saved {
		return nil
	}
	prior, err := rest.ReadVoiceURL(ctx, sid)
	if err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, saved := a.priorCallees[sid]; !saved {
		if a.priorCallees == nil {
			a.priorCallees = map[string]string{}
		}
		a.priorCallees[sid] = prior
	}
	return nil
}

// WaitForCall points the number's voice URL at this adapter and waits up to
// timeout (0: DefaultStreamConnectTimeout) for a caller's media stream.
func (a *Adapter) WaitForCall(ctx context.Context, timeout time.Duration) error {
	a.mu.Lock()
	err := a.dialPreconditionsLocked(modeAnswer)
	rest, base, sid := a.rest, a.publicBaseURL, a.phoneNumberSID
	a.mu.Unlock()
	if err != nil {
		return err
	}
	if timeout <= 0 {
		timeout = DefaultStreamConnectTimeout
	}
	ctx, span := voice.StartSpan(ctx, SpanAdapterDial,
		attribute.String("voice.adapter.class", Name),
		attribute.String("voice.twilio.direction", "inbound"),
		attribute.String("voice.twilio.to", RedactE164(a.phoneNumber)))
	err = a.answer(ctx, span, rest, base, sid, timeout)
	voice.EndSpan(span, err)
	return err
}

func (a *Adapter) answer(ctx context.Context, span trace.Span, rest REST, base, sid string, timeout time.Duration) error {
	a.resetConnectionStateForDial()
	// A repeat WaitForCall finds our own webhook installed: keep the URL
	// read the first time, which is the one Disconnect must restore.
	a.mu.Lock()
	read := a.priorVoiceRead
	a.mu.Unlock()
	if !read {
		prior, err := rest.ReadVoiceURL(ctx, sid)
		if err != nil {
			return err
		}
		a.mu.Lock()
		a.priorVoiceURL, a.priorVoiceRead = prior, true
		a.mu.Unlock()
	}
	if err := rest.WriteVoiceURL(ctx, sid, strings.TrimSuffix(base, "/")+"/twilio/voice"); err != nil {
		return err
	}
	a.mu.Lock()
	sig := a.streamConnected
	a.mu.Unlock()
	started := time.Now()
	if err := waitSignal(ctx, sig, timeout); err != nil {
		if errors.Is(err, ErrStreamConnectTimeout) {
			voice.SetSpanAttributes(span, attribute.String("voice.twilio.dial_outcome", "stream_connect_timeout"))
		}
		return err
	}
	voice.SetSpanAttributes(span,
		attribute.String("voice.twilio.call_sid", a.CallSID()),
		attribute.Int64("voice.twilio.stream_connect_latency_ms", time.Since(started).Milliseconds()))
	return nil
}

// dialPreconditionsLocked checks the adapter can dial in mode m and enters
// it. The direction is fixed per connection: an adapter that answered must
// reconnect to call out, and vice versa.
func (a *Adapter) dialPreconditionsLocked(m mode) error {
	if a.embed != nil {
		return errors.New("TwilioAgentAdapter: an embedded media stream cannot place or answer calls; " +
			"the embedder owns the call")
	}
	if err := a.assertConnectedLocked(); err != nil {
		return err
	}
	if a.rest == nil || a.publicBaseURL == "" {
		return errors.New("TwilioAgentAdapter: not connected")
	}
	if a.mode == m {
		return nil
	}
	if a.mode != modeIdle {
		//lint:ignore ST1005 same message as the JS SDK's Twilio adapter
		return fmt.Errorf("TwilioAgentAdapter: already in '%s' mode; cannot switch to '%s'. "+
			"Disconnect and reconnect to reuse this adapter in the other direction.", a.mode, m)
	}
	a.mode = m
	return nil
}

// assertCalleeAllowed refuses an a-leg destination that is not explicitly
// allowlisted; membership is exact, so a near-miss is a refusal.
func (a *Adapter) assertCalleeAllowed(to string) error {
	if a.allowedCallees == nil {
		//lint:ignore ST1005 same message as the JS SDK's Twilio adapter
		return fmt.Errorf(`placeCall: attachStream="a-leg" requires allowedCallees. a-leg dials numbers `+
			`this Twilio account does not own, so destinations are deny-by-default: set `+
			`twilio.Options.AllowedCallees listing every number this adapter may dial, including %s.`, RedactE164(to))
	}
	n, err := NormalizeE164(to)
	if err != nil {
		return err
	}
	if _, ok := a.allowedCallees[n]; !ok {
		//lint:ignore ST1005 same message as the JS SDK's Twilio adapter
		return fmt.Errorf("placeCall: destination %s is not in allowedCallees. Add it to "+
			"twilio.Options.AllowedCallees to permit this destination.", RedactE164(to))
	}
	return nil
}

// assertTunnelReady refuses to originate until the public URL is reachable
// from the edge; a failure that is not already a TunnelNotReadyError is
// wrapped in one.
func (a *Adapter) assertTunnelReady(ctx context.Context) error {
	a.mu.Lock()
	ready, base := a.activeReady, a.publicBaseURL
	a.mu.Unlock()
	if ready == nil {
		return nil
	}
	err := ready.WaitUntilEdgeReachable(ctx)
	if err == nil {
		return nil
	}
	var nr *TunnelNotReadyError
	if errors.As(err, &nr) {
		return err
	}
	return &TunnelNotReadyError{
		Msg: fmt.Sprintf("placeCall: publicBaseUrl %q is not reachable from the edge yet, so Twilio's media "+
			"stream would connect to nothing. Not originating.", base),
		Err: err,
	}
}

// connectStreamTwiML is the a-leg origination TwiML: the stream on our own
// leg, carrying the nonce as a <Parameter>.
func connectStreamTwiML(wsURL, nonce string) string {
	return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="` + escapeXMLAttr(wsURL) + `">` +
		`<Parameter name="nonce" value="` + escapeXMLAttr(nonce) + `"/></Stream></Connect></Response>`
}

// resetConnectionStateForDial invalidates any socket adopted under an
// earlier call generation and clears the per-dial state it writes: a fresh
// connected signal (an early socket's resolve is discarded), no transport,
// no buffered audio, no terminal state, zero frames.
func (a *Adapter) resetConnectionStateForDial() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.callGeneration++
	a.streamConn, a.streamSID = nil, ""
	a.streamConnected = newSignal()
	a.queue.Clear()
	if a.gate != nil {
		a.gate.Reset()
	}
	a.streamEnded = false
	a.endedReason = EndedNone
	a.framesReceived = 0
}

// armMaxDurationTimer starts the watchdog that ends callSID after d. A
// previous watchdog is cancelled first, so it can never hang up a newer
// call.
//
// Two tokens silence a stale watchdog: maxDurGen (moved by any cancel or
// re-arm) suppresses it entirely, while callGeneration (moved by any dial)
// only stops it from relabelling or closing a newer call: the expired call
// itself is still hung up.
func (a *Adapter) armMaxDurationTimer(d time.Duration, callSID, to string) {
	a.mu.Lock()
	a.cancelMaxDurationLocked()
	maxGen, callGen := a.maxDurGen, a.callGeneration
	ctx, cancel := context.WithCancel(context.Background())
	a.maxDurCancel = cancel
	wait := a.awaitMaxDuration
	a.mu.Unlock()
	go func() {
		if wait(ctx, d) != nil {
			return
		}
		a.mu.Lock()
		current := maxGen == a.maxDurGen
		a.mu.Unlock()
		if current {
			a.onMaxDurationExpired(d, callSID, to, callGen, maxGen)
		}
	}()
}

// onMaxDurationExpired hangs the call up over REST and closes its socket.
func (a *Adapter) onMaxDurationExpired(d time.Duration, callSID, to string, callGen, maxGen int) {
	a.logger.Warn("twilio: max call duration reached — ending call",
		"seconds", int(d/time.Second), "to", RedactE164(to), "callSid", callSID)
	stillOurs := func() bool { return callGen == a.callGeneration && maxGen == a.maxDurGen }
	a.mu.Lock()
	if stillOurs() {
		a.setEndedReasonLocked(EndedMaxDuration)
	}
	rest := a.rest
	a.mu.Unlock()
	if rest != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		// Best effort: Twilio's own TimeLimit is the backstop.
		_ = rest.EndCall(ctx, callSID)
		cancel()
	}
	a.mu.Lock()
	var conn interface{ Close() }
	if stillOurs() && a.streamConn != nil {
		conn = a.streamConn
	}
	a.mu.Unlock()
	if conn != nil {
		conn.Close()
	}
}

// abandonOriginatedCall disarms the watchdog and hangs up a call nothing
// will ever stream on. Best effort: TimeLimit remains the backstop.
func (a *Adapter) abandonOriginatedCall(callSID string) {
	a.mu.Lock()
	a.cancelMaxDurationLocked()
	rest := a.rest
	a.mu.Unlock()
	if rest != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		_ = rest.EndCall(ctx, callSID)
		cancel()
	}
}

// cancelMaxDurationLocked disarms the watchdog; idempotent.
func (a *Adapter) cancelMaxDurationLocked() {
	a.maxDurGen++
	if a.maxDurCancel != nil {
		a.maxDurCancel()
		a.maxDurCancel = nil
	}
}

// setEndedReasonLocked records how the session ended. The duration cap's
// verdict is never overwritten by the close it causes.
func (a *Adapter) setEndedReasonLocked(r EndedReason) {
	if a.endedReason != EndedMaxDuration {
		a.endedReason = r
	}
}
