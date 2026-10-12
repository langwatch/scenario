package twilio

// Ported from twilio-spans.test.ts: the Twilio contributions to the voice
// spans. T8 (a throwing span processor at the dial site) is not ported, as
// in JS: voice.EndSpan already guards span.End, so the test could not tell
// an adapter with a dial span from one without. T9 (Python/TS parity) is the
// attribute keys hard-coded here.

import (
	"bytes"
	"context"
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/langwatch/scenario/go/voice"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

const spanStream = "MZ775"

func start775() string { return start695(spanStream, "CA775") }

func finished() tracetest.SpanStubs { return spans.GetSpans() }

func byName(ss tracetest.SpanStubs, name string) (tracetest.SpanStub, bool) {
	for i := len(ss) - 1; i >= 0; i-- {
		if ss[i].Name == name {
			return ss[i], true
		}
	}
	return tracetest.SpanStub{}, false
}

func named(ss tracetest.SpanStubs, name string) tracetest.SpanStubs {
	var out tracetest.SpanStubs
	for _, s := range ss {
		if s.Name == name {
			out = append(out, s)
		}
	}
	return out
}

func attr(s tracetest.SpanStub, key string) (attribute.Value, bool) {
	for _, kv := range s.Attributes {
		if string(kv.Key) == key {
			return kv.Value, true
		}
	}
	return attribute.Value{}, false
}

func mustSpan(t *testing.T, name string) tracetest.SpanStub {
	t.Helper()
	s, ok := byName(finished(), name)
	if !ok {
		t.Fatalf("no %s span", name)
	}
	return s
}

func wantAttr(t *testing.T, s tracetest.SpanStub, key string, want any) {
	t.Helper()
	v, ok := attr(s, key)
	if !ok {
		t.Fatalf("%s lacks %s", s.Name, key)
	}
	if got := v.AsInterface(); got != want {
		t.Fatalf("%s %s = %v (%T), want %v (%T)", s.Name, key, got, got, want, want)
	}
}

func spanAdapter(t *testing.T, opts ...adapterOpt) (*Adapter, *spyREST) {
	t.Helper()
	spans.Reset()
	rest := newSpyREST()
	rest.priorVoiceURL = "https://old-webhook.example.com/previous"
	a := makeAdapter(t, rest, append([]adapterOpt{withoutGate()}, opts...)...)
	return a, rest
}

func connectSpan(t *testing.T, a *Adapter) {
	t.Helper()
	if err := withSpan(voice.SpanAdapterConnect, a.Connect); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Disconnect(context.Background()) })
}

func disconnectSpan(a *Adapter) {
	_ = withSpan(voice.SpanAdapterDisconnect, a.Disconnect)
}

func silence800() string { return mediaFrame(spanStream, bytes.Repeat([]byte{0x7f}, 800)) }

func TestSpanTurnOverTwilioHasTheBaseSpans(t *testing.T) {
	a, _ := spanAdapter(t)
	connected(t, a)
	c := newConn()
	loop := result(func() error { return a.runStreamSession(c) })
	c.pushFrame(start775())
	waitUntil(t, func() bool { return state(a, func(a *Adapter) string { return a.streamSID }) == spanStream }, "start")
	c.pushFrame(silence800())
	waitUntil(t, func() bool { return a.queue.Len() > 0 }, "the buffered chunk")
	driveCall(t, agentFor(a, 50*time.Millisecond), voice.AudioChunk{Data: make([]byte, 2400)})
	c.pushFrame(stopFrame)
	await(t, loop)
	turn := mustSpan(t, voice.SpanTurn)
	wantAttr(t, turn, "voice.adapter.class", "TwilioAgentAdapter")
	for _, name := range []string{voice.SpanAudioSend, voice.SpanAudioReceive} {
		if s := mustSpan(t, name); s.Parent.SpanID() != turn.SpanContext.SpanID() {
			t.Fatalf("%s is not parented under the turn", name)
		}
	}
}

func TestSpanConnectAttributes(t *testing.T) {
	a, _ := spanAdapter(t, func(o *Options) { o.SkipSignatureValidation = false })
	connectSpan(t, a)
	s := mustSpan(t, voice.SpanAdapterConnect)
	wantAttr(t, s, "voice.twilio.phone_number_sid", phoneSID)
	wantAttr(t, s, "voice.twilio.validate_signature", true)
	wantAttr(t, s, "voice.twilio.webhook_port", int64(0))
	if _, ok := attr(s, "voice.twilio.direction"); ok {
		t.Fatal("connect is direction-agnostic")
	}
}

func TestSpanDisconnectCounters(t *testing.T) {
	a, _ := spanAdapter(t)
	connectSpan(t, a)
	frames := []string{start775(),
		mediaFrame(spanStream, bytes.Repeat([]byte{0x7f}, 160)), mediaFrame(spanStream, bytes.Repeat([]byte{0x7f}, 160)),
		mediaFrame(spanStream, bytes.Repeat([]byte{0x7f}, 160)), dtmfFrame("1"), dtmfFrame("5"), stopFrame}
	await(t, drive(t, a, scripted(frames...), true))
	disconnectSpan(a)
	s := mustSpan(t, voice.SpanAdapterDisconnect)
	wantAttr(t, s, "voice.twilio.frames_received", int64(3))
	wantAttr(t, s, "voice.twilio.dtmf_received", int64(2))
	wantAttr(t, s, "voice.twilio.stream_ended_reason", "stop")
	wantAttr(t, s, "voice.twilio.speech_gate.enabled", false)
	wantAttr(t, s, "voice.twilio.speech_gate.dropped_chunks", int64(0))
}

func TestSpanEndedReasons(t *testing.T) {
	for _, c := range []struct {
		name string
		conn func() *fakeConn
		want string
	}{
		{"close", func() *fakeConn { return scripted(start775()) }, "close"},
		{"error", func() *fakeConn {
			c := newConn(start775())
			c.push(item{err: errors.New("boom: transport failure")})
			return c
		}, "error"},
		{"none", nil, "none"},
	} {
		t.Run(c.name, func(t *testing.T) {
			a, _ := spanAdapter(t)
			connectSpan(t, a)
			if c.conn != nil {
				err := await(t, drive(t, a, c.conn(), true))
				if c.want == "error" && (err == nil || !strings.Contains(err.Error(), "boom")) {
					t.Fatalf("session err %v", err)
				}
			}
			disconnectSpan(a)
			wantAttr(t, mustSpan(t, voice.SpanAdapterDisconnect), "voice.twilio.stream_ended_reason", c.want)
		})
	}
}

func TestSpanWebhookCountersAndReset(t *testing.T) {
	const token = "the-shared-secret"
	a, _ := spanAdapter(t, func(o *Options) { o.SkipSignatureValidation, o.AuthToken = false, token })
	connectSpan(t, a)
	resp, _ := postVoice(t, a, url.Values{"From": {"+14155551234"}}, "")
	if resp.StatusCode != 403 {
		t.Fatalf("unsigned: %d", resp.StatusCode)
	}
	sig := signFixture(token, a.PublicBaseURL()+"/twilio/voice", map[string]string{"From": "+14155551234"})
	if resp, _ = postVoice(t, a, url.Values{"From": {"+14155551234"}}, sig); resp.StatusCode != 200 {
		t.Fatalf("signed: %d", resp.StatusCode)
	}
	disconnectSpan(a)
	s := mustSpan(t, voice.SpanAdapterDisconnect)
	wantAttr(t, s, "voice.twilio.webhook_invocations", int64(2))
	wantAttr(t, s, "voice.twilio.webhook_rejected", int64(1))

	// A reconnect on the same instance starts its counters at zero.
	connectSpan(t, a)
	disconnectSpan(a)
	ds := named(finished(), voice.SpanAdapterDisconnect)
	if len(ds) != 2 {
		t.Fatalf("%d disconnect spans", len(ds))
	}
	wantAttr(t, ds[1], "voice.twilio.webhook_invocations", int64(0))
	wantAttr(t, ds[1], "voice.twilio.webhook_rejected", int64(0))
}

func TestSpanRESTRestoreFailed(t *testing.T) {
	for _, fail := range []bool{false, true} {
		a, rest := spanAdapter(t)
		connectSpan(t, a)
		if err := dialAndConnect(t, a, func() error { return a.WaitForCall(context.Background(), 0) }); err != nil {
			t.Fatal(err)
		}
		if fail {
			rest.writeVoiceURL = func(_, u string) error {
				if u == rest.priorVoiceURL {
					return errors.New("simulated Twilio REST outage")
				}
				return nil
			}
		}
		disconnectSpan(a)
		wantAttr(t, mustSpan(t, voice.SpanAdapterDisconnect), "voice.twilio.rest_restore_failed", fail)
	}
}

func TestSpanEndedReasonReflectsTheActualCloseOfALiveCall(t *testing.T) {
	a, _ := spanAdapter(t)
	connectSpan(t, a)
	c, err := dialStream(t, a, "/twilio/stream")
	if err != nil {
		t.Fatal(err)
	}
	c.send(start775())
	waitUntil(t, func() bool { return state(a, func(a *Adapter) string { return a.streamSID }) == spanStream }, "start")
	for range 3 {
		c.send(silence800())
	}
	waitUntil(t, func() bool { return state(a, func(a *Adapter) int { return a.framesReceived }) == 3 }, "three frames")
	disconnectSpan(a)
	s := mustSpan(t, voice.SpanAdapterDisconnect)
	wantAttr(t, s, "voice.twilio.frames_received", int64(3))
	if v, _ := attr(s, "voice.twilio.stream_ended_reason"); v.AsString() == "none" {
		t.Fatal("the reason was stamped before the teardown closed the live stream")
	}
}

func TestSpanDialOutbound(t *testing.T) {
	a, _ := spanAdapter(t)
	connected(t, a)
	if err := dialAndConnect(t, a, placeBLeg(a, func(o *CallOptions) { o.Record = true })); err != nil {
		t.Fatal(err)
	}
	dials := named(finished(), SpanAdapterDial)
	if len(dials) != 1 {
		t.Fatalf("%d dial spans", len(dials))
	}
	d := dials[0]
	if d.Status.Code == codes.Error {
		t.Fatal("dial ERROR")
	}
	wantAttr(t, d, "voice.adapter.class", "TwilioAgentAdapter")
	wantAttr(t, d, "voice.twilio.direction", "outbound")
	wantAttr(t, d, "voice.twilio.call_sid", originatedCallSID)
	wantAttr(t, d, "voice.twilio.record", true)
	wantAttr(t, d, "voice.twilio.to", "***7777")
	wantAttr(t, d, "voice.twilio.from", "***1234")
	if _, ok := attr(d, "voice.twilio.stream_connect_latency_ms"); !ok {
		t.Fatal("no latency")
	}
	if _, ok := attr(d, "voice.twilio.dial_outcome"); ok {
		t.Fatal("dial outcome on a successful dial")
	}
}

func TestSpanDialInbound(t *testing.T) {
	a, _ := spanAdapter(t)
	connected(t, a)
	if err := dialAndConnect(t, a, func() error { return a.WaitForCall(context.Background(), 0) }); err != nil {
		t.Fatal(err)
	}
	d := mustSpan(t, SpanAdapterDial)
	wantAttr(t, d, "voice.twilio.direction", "inbound")
	if d.Status.Code == codes.Error {
		t.Fatal("dial ERROR")
	}
}

func TestSpanDialTimeoutIsMarquee(t *testing.T) {
	a, _ := spanAdapter(t)
	connected(t, a)
	err := placeBLeg(a, func(o *CallOptions) { o.Timeout = 50 * time.Millisecond })()
	if err == nil || !strings.Contains(err.Error(), "timed out") || !errors.Is(err, ErrStreamConnectTimeout) {
		t.Fatalf("err %v", err)
	}
	d := mustSpan(t, SpanAdapterDial)
	if d.Status.Code != codes.Error {
		t.Fatal("dial not ERROR")
	}
	wantAttr(t, d, "voice.twilio.dial_outcome", "stream_connect_timeout")
}

func TestSpanDialRESTFailureRecordsTheOriginalError(t *testing.T) {
	a, rest := spanAdapter(t)
	rest.placeCall = func(PlaceCallParams) (string, error) { return "", errors.New("Twilio REST: rate limited") }
	connected(t, a)
	if err := placeBLeg(a)(); err == nil || !strings.Contains(err.Error(), "rate limited") {
		t.Fatalf("err %v", err)
	}
	d := mustSpan(t, SpanAdapterDial)
	if d.Status.Code != codes.Error {
		t.Fatal("dial not ERROR")
	}
	found := false
	for _, e := range d.Events {
		if e.Name == "exception" {
			for _, kv := range e.Attributes {
				if kv.Key == "exception.message" && strings.Contains(kv.Value.AsString(), "rate limited") {
					found = true
				}
			}
		}
	}
	if !found {
		t.Fatal("the original exception is not recorded")
	}
	if _, ok := attr(d, "voice.twilio.dial_outcome"); ok {
		t.Fatal("a REST failure is not a stream-connect timeout")
	}
}

func TestSpanCountIsInvariantToFrameCount(t *testing.T) {
	run := func(n int) int {
		a, _ := spanAdapter(t)
		connectSpan(t, a)
		frames := []string{start775()}
		for range n {
			frames = append(frames, mediaFrame(spanStream, bytes.Repeat([]byte{0x7f}, 160)))
		}
		await(t, drive(t, a, scripted(append(frames, stopFrame)...), true))
		disconnectSpan(a)
		count := 0
		for _, s := range finished() {
			if strings.HasPrefix(s.Name, "voice.") {
				count++
			}
		}
		return count
	}
	if few, many := run(3), run(30); few != many || few != 2 {
		t.Fatalf("%d spans for 3 frames, %d for 30", few, many)
	}
}

// backgroundReceives are the receive spans the media loop emitted.
func backgroundReceives() tracetest.SpanStubs {
	var out tracetest.SpanStubs
	for _, s := range named(finished(), voice.SpanAudioReceive) {
		if v, ok := attr(s, "voice.twilio.recv.source"); ok && v.AsString() == "background_loop" {
			out = append(out, s)
		}
	}
	return out
}

// liveTurn starts a turn and returns once the adapter saw it begin.
func liveTurn(t *testing.T, a *Adapter) chan int {
	t.Helper()
	ag := agentFor(a, 50*time.Millisecond)
	ch := make(chan int, 1)
	go func() {
		msgs, err := ag.Turn(context.Background(), scenarioInput(voice.AudioChunk{Data: make([]byte, 2400)}))
		if err != nil {
			t.Errorf("turn: %v", err)
		}
		ch <- audioBytes(msgs)
	}()
	waitUntil(t, func() bool { return state(a, func(a *Adapter) bool { return a.turnCtx != nil }) }, "the turn to begin")
	return ch
}

func spanStreamSession(t *testing.T, a *Adapter) (*fakeConn, chan error) {
	t.Helper()
	c := newConn()
	loop := result(func() error { return a.runStreamSession(c) })
	c.pushFrame(start775())
	waitUntil(t, func() bool { return state(a, func(a *Adapter) string { return a.streamSID }) == spanStream }, "start")
	return c, loop
}

func TestSpanBackgroundReceiveIsParentedToTheLiveTurn(t *testing.T) {
	a, _ := spanAdapter(t)
	connected(t, a)
	c, loop := spanStreamSession(t, a)
	call := liveTurn(t, a)
	c.pushFrame(silence800())
	if n := <-call; n == 0 {
		t.Fatal("no audio")
	}
	c.pushFrame(stopFrame)
	await(t, loop)
	turn := mustSpan(t, voice.SpanTurn)
	bg := backgroundReceives()
	if len(bg) != 1 || bg[0].Parent.SpanID() != turn.SpanContext.SpanID() {
		t.Fatalf("%d background spans, parented under the turn: %v", len(bg), len(bg) == 1 && bg[0].Parent.SpanID() == turn.SpanContext.SpanID())
	}
	if v, _ := attr(bg[0], "voice.audio.bytes"); v.AsInt64() <= 0 {
		t.Fatal("no delivered byte count")
	}
}

func TestSpanOneBackgroundReceivePerTurn(t *testing.T) {
	a, _ := spanAdapter(t)
	connected(t, a)
	c, loop := spanStreamSession(t, a)
	call := liveTurn(t, a)
	for range 3 {
		c.pushFrame(silence800())
	}
	<-call
	c.pushFrame(stopFrame)
	await(t, loop)
	if bg := backgroundReceives(); len(bg) != 1 {
		t.Fatalf("%d background spans for one turn", len(bg))
	}
}

func TestSpanPreBufferedTurnHasNoBackgroundMarker(t *testing.T) {
	a, _ := spanAdapter(t)
	connected(t, a)
	c, loop := spanStreamSession(t, a)
	c.pushFrame(silence800())
	waitUntil(t, func() bool { return a.queue.Len() > 0 }, "the buffered chunk")
	<-liveTurn(t, a)
	c.pushFrame(stopFrame)
	await(t, loop)
	if len(named(finished(), voice.SpanAudioReceive))-len(backgroundReceives()) < 1 || len(backgroundReceives()) != 0 {
		t.Fatal("a pre-buffered turn got a background marker, or no base receive span")
	}
}

func TestSpanNoBackgroundSpanOutsideATurn(t *testing.T) {
	a, _ := spanAdapter(t)
	connected(t, a)
	c, loop := spanStreamSession(t, a)
	c.pushFrame(silence800())
	waitUntil(t, func() bool { return a.queue.Len() > 0 }, "the buffered chunk")
	c.pushFrame(stopFrame)
	await(t, loop)
	if bg := backgroundReceives(); len(bg) != 0 {
		t.Fatalf("%d background spans with no turn live", len(bg))
	}
}
