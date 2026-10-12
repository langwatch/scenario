package twilio

// Ported from twilio-call-duration.test.ts: the a-leg call-duration cap
// (Twilio's TimeLimit plus the local watchdog) and the stream-connect
// timeout hang-up.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// controlledExpiry replaces the watchdog's wait: the test decides when time
// is up. It ignores the cancellation context on purpose, so what silences a
// stale watchdog is the generation check, not the timer.
type controlledExpiry struct {
	mu       sync.Mutex
	d        time.Duration
	armed    chan struct{}
	released chan struct{}
}

func newExpiry() *controlledExpiry {
	return &controlledExpiry{armed: make(chan struct{}), released: make(chan struct{})}
}

func (e *controlledExpiry) wait(_ context.Context, d time.Duration) error {
	e.mu.Lock()
	e.d = d
	e.mu.Unlock()
	close(e.armed)
	<-e.released
	return nil
}

func (e *controlledExpiry) release() { close(e.released) }

func (e *controlledExpiry) waitArmed(t *testing.T) {
	t.Helper()
	select {
	case <-e.armed:
	case <-time.After(2 * time.Second):
		t.Fatal("max-duration timer was never armed")
	}
}

func install(a *Adapter, e *controlledExpiry) {
	a.mu.Lock()
	a.awaitMaxDuration = e.wait
	a.mu.Unlock()
}

// settle lets a released watchdog run to completion: a cancelled one has
// no observable effect to wait for.
func settle() { time.Sleep(30 * time.Millisecond) }

func endedReason(a *Adapter) EndedReason {
	return state(a, func(a *Adapter) EndedReason { return a.endedReason })
}

func withDuration(d time.Duration) func(*CallOptions) {
	return func(o *CallOptions) { o.MaxCallDuration = d }
}

func TestALegPlacesTheTimeLimit(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	if err := dialAndConnect(t, a, placeALeg(a, withDuration(120*time.Second))); err != nil {
		t.Fatal(err)
	}
	if got := rest.places()[0].TimeLimitSeconds; got != 120 {
		t.Fatalf("TimeLimit %d", got)
	}
	rest = newSpyREST()
	a = connected(t, makeAdapter(t, rest))
	if err := dialAndConnect(t, a, placeALeg(a)); err != nil {
		t.Fatal(err)
	}
	if got := rest.places()[0].TimeLimitSeconds; got != int(DefaultMaxCallDuration/time.Second) {
		t.Fatalf("default TimeLimit %d", got)
	}
}

func TestDurationOutOfBoundsThrowsBeforeOrigination(t *testing.T) {
	for _, c := range []struct {
		opts func(*CallOptions)
		want string
		bLeg bool
	}{
		{withDuration(MaxCallDurationCap + time.Second), "300s cap", false},
		{withDuration(-time.Second), "positive number of seconds", false},
		{withDuration(60 * time.Second), `attachStream="a-leg"`, true},
	} {
		rest := newSpyREST()
		a := connected(t, makeAdapter(t, rest))
		place := placeALeg(a, c.opts)
		if c.bLeg {
			place = placeBLeg(a, c.opts)
		}
		if err := place(); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("want %q, got %v", c.want, err)
		}
		if len(rest.places()) != 0 {
			t.Error("originated anyway")
		}
	}
}

func TestExpiryEndsTheCallAndClosesTheSocket(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	e := newExpiry()
	install(a, e)
	if err := dialAndConnect(t, a, placeALeg(a, withDuration(42*time.Second), func(o *CallOptions) { o.Timeout = 2 * time.Minute })); err != nil {
		t.Fatal(err)
	}
	ws := newConn()
	a.mu.Lock()
	a.streamConn = ws
	a.mu.Unlock()
	e.waitArmed(t)
	if e.d != 42*time.Second {
		t.Fatalf("watchdog got %v, not the max duration", e.d)
	}
	e.release()
	waitUntil(t, func() bool { return len(rest.ends()) == 1 }, "the REST hang-up")
	waitUntil(t, ws.closed, "the socket close")
	if rest.ends()[0] != originatedCallSID || endedReason(a) != EndedMaxDuration {
		t.Fatalf("ended %v reason %s", rest.ends(), endedReason(a))
	}
}

func TestDisconnectDisarmsTheWatchdog(t *testing.T) {
	rest := newSpyREST()
	a := makeAdapter(t, rest)
	if err := a.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	e := newExpiry()
	install(a, e)
	if err := dialAndConnect(t, a, placeALeg(a, withDuration(42*time.Second))); err != nil {
		t.Fatal(err)
	}
	e.waitArmed(t)
	_ = a.Disconnect(context.Background())
	e.release()
	settle()
	// The handler stamps the reason before calling REST, so an untouched
	// reason proves it never ran.
	if len(rest.ends()) != 0 || endedReason(a) != EndedNone {
		t.Fatalf("ended %v reason %s", rest.ends(), endedReason(a))
	}
}

func TestStreamEndDisarmsTheWatchdog(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	e := newExpiry()
	install(a, e)
	call := result(placeALeg(a, withDuration(42*time.Second)))
	waitUntil(t, func() bool { return len(rest.places()) == 1 }, "origination")
	e.waitArmed(t)
	nonce := state(a, func(a *Adapter) string { return a.streamNonce })
	await(t, drive(t, a, newConn(startFrame(startOpts{nonce: nonce}), stopFrame), false))
	if err := await(t, call); err != nil {
		t.Fatal(err)
	}
	e.release()
	settle()
	if len(rest.ends()) != 0 || endedReason(a) != EndedStop {
		t.Fatalf("ended %v reason %s", rest.ends(), endedReason(a))
	}
}

func TestStreamConnectTimeoutHangsUpTheALegCallOnly(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	if err := placeALeg(a, func(o *CallOptions) { o.Timeout = 20 * time.Millisecond })(); err == nil {
		t.Fatal("expected a timeout")
	}
	if got := rest.ends(); len(got) != 1 || got[0] != originatedCallSID {
		t.Fatalf("a-leg timeout ended %v", got)
	}
	rest = newSpyREST()
	a = connected(t, makeAdapter(t, rest))
	if err := placeBLeg(a, func(o *CallOptions) { o.Timeout = 20 * time.Millisecond })(); err == nil {
		t.Fatal("expected a timeout")
	}
	if got := rest.ends(); len(got) != 0 {
		t.Fatalf("b-leg timeout ended %v", got)
	}
}

func TestASecondPlaceCallReplacesTheFirstTimer(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	first := newExpiry()
	install(a, first)
	if err := dialAndConnect(t, a, placeALeg(a, withDuration(42*time.Second))); err != nil {
		t.Fatal(err)
	}
	first.waitArmed(t)
	second := newExpiry()
	install(a, second)
	if err := dialAndConnect(t, a, placeALeg(a, withDuration(42*time.Second))); err != nil {
		t.Fatal(err)
	}
	second.waitArmed(t)
	first.release()
	settle()
	if len(rest.ends()) != 0 || endedReason(a) != EndedNone {
		t.Fatalf("ended %v reason %s", rest.ends(), endedReason(a))
	}
	second.release()
}

const (
	sidA = "CAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	sidB = "CBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

// twoCalls makes the spy hand out call A then B, and hold A's hang-up until
// releaseEnd is closed.
func twoCalls(rest *spyREST) (releaseEnd chan struct{}) {
	sids := []string{sidA, sidB}
	var mu sync.Mutex
	rest.placeCall = func(PlaceCallParams) (string, error) {
		mu.Lock()
		defer mu.Unlock()
		s := sids[0]
		sids = sids[1:]
		return s, nil
	}
	releaseEnd = make(chan struct{})
	rest.endCall = func(sid string) error {
		if sid == sidA {
			<-releaseEnd
		}
		return nil
	}
	return releaseEnd
}

// connectCallA places a-leg call A and connects its socket.
func connectCallA(t *testing.T, a *Adapter, rest *spyREST) *controlledExpiry {
	t.Helper()
	e := newExpiry()
	install(a, e)
	call := result(placeALeg(a, withDuration(42*time.Second), func(o *CallOptions) { o.Timeout = 2 * time.Minute }))
	waitUntil(t, func() bool { return len(rest.places()) == 1 }, "call A's origination")
	nonceA := nonceRE.FindStringSubmatch(rest.places()[0].TwiML)[1]
	waitUntil(t, func() bool { return a.CallSID() == sidA }, "call A's SID")
	drive(t, a, newConn(startFrame(startOpts{nonce: nonceA, callSID: sidA})), true)
	if err := await(t, call); err != nil {
		t.Fatal(err)
	}
	e.waitArmed(t)
	return e
}

func TestExpiredWatchdogInFlightDoesNotCloseANewerCall(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	releaseEnd := twoCalls(rest)
	expiryA := connectCallA(t, a, rest)

	// Expire A; its hang-up blocks in flight.
	expiryA.release()
	waitUntil(t, func() bool { return len(rest.ends()) == 1 }, "A's hang-up")

	// A-leg call B takes over and connects.
	expiryB := newExpiry()
	install(a, expiryB)
	callB := result(placeALeg(a, withDuration(42*time.Second), func(o *CallOptions) { o.Timeout = 2 * time.Minute }))
	waitUntil(t, func() bool { return len(rest.places()) == 2 }, "B's origination")
	expiryB.waitArmed(t)
	nonceB := nonceRE.FindStringSubmatch(rest.places()[1].TwiML)[1]
	genuineB := newConn(startFrame(startOpts{nonce: nonceB, callSID: sidB}))
	drive(t, a, genuineB, true)
	if err := await(t, callB); err != nil {
		t.Fatal(err)
	}

	close(releaseEnd)
	settle()
	if genuineB.closed() || streamConnOf(a) != any(genuineB) {
		t.Fatal("A's expired watchdog closed B's socket")
	}
	if got := rest.ends(); len(got) != 1 || got[0] != sidA {
		t.Fatalf("ended %v", got)
	}
	expiryB.release()
	waitUntil(t, func() bool { return len(rest.ends()) == 2 }, "B's own watchdog")
	if rest.ends()[1] != sidB {
		t.Fatalf("ended %v", rest.ends())
	}
}

func TestBLegTakeoverIsInvisibleToTheReArmCounter(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	releaseEnd := twoCalls(rest)
	expiryA := connectCallA(t, a, rest)
	expiryA.release()
	waitUntil(t, func() bool { return len(rest.ends()) == 1 }, "A's hang-up")

	// A plain b-leg B bumps only the call generation.
	callB := result(func() error { return a.PlaceCall(context.Background(), CallOptions{To: aLegDestination}) })
	waitUntil(t, func() bool { return len(rest.places()) == 2 }, "B's origination")
	genuineB := newConn(startFrame(startOpts{callSID: sidB}))
	drive(t, a, genuineB, true)
	if err := await(t, callB); err != nil {
		t.Fatal(err)
	}
	close(releaseEnd)
	settle()
	if genuineB.closed() || streamConnOf(a) != any(genuineB) || endedReason(a) == EndedMaxDuration {
		t.Fatal("A's expired watchdog touched the b-leg call")
	}
	if got := rest.ends(); len(got) != 1 || got[0] != sidA {
		t.Fatalf("ended %v", got)
	}
}

func TestStaleWatchdogFiringAfterTakeoverNeverRelabels(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	close(twoCalls(rest))
	expiryA := connectCallA(t, a, rest)

	callB := result(func() error { return a.PlaceCall(context.Background(), CallOptions{To: aLegDestination}) })
	waitUntil(t, func() bool { return len(rest.places()) == 2 }, "B's origination")
	genuineB := newConn(startFrame(startOpts{callSID: sidB}))
	drive(t, a, genuineB, true)
	if err := await(t, callB); err != nil {
		t.Fatal(err)
	}
	if endedReason(a) != EndedNone {
		t.Fatalf("reason %s", endedReason(a))
	}
	expiryA.release()
	waitUntil(t, func() bool { return len(rest.ends()) == 1 }, "A's own hang-up")
	settle()
	if endedReason(a) == EndedMaxDuration || genuineB.closed() {
		t.Fatal("a stale watchdog relabelled or closed a call it does not own")
	}
}

// recordingTwilio is a fake Twilio REST API recording each request.
type recordingTwilio struct {
	mu    sync.Mutex
	paths []string
	forms []url.Values
	auth  []string
	body  string
}

func newRecordingTwilio(t *testing.T, body string) (*recordingTwilio, *RESTClient) {
	rt := &recordingTwilio{body: body}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		rt.mu.Lock()
		rt.paths = append(rt.paths, r.Method+" "+r.URL.RequestURI())
		rt.forms = append(rt.forms, r.PostForm)
		rt.auth = append(rt.auth, r.Header.Get("Authorization"))
		rt.mu.Unlock()
		if strings.Contains(r.URL.Path, "/fail") {
			http.Error(w, `{"message":"rate limited"}`, http.StatusTooManyRequests)
			return
		}
		_, _ = w.Write([]byte(rt.body))
	}))
	t.Cleanup(srv.Close)
	return rt, &RESTClient{AccountSID: "ACtest", AuthToken: "secret", BaseURL: srv.URL}
}

func TestRESTPlaceCallWireBody(t *testing.T) {
	rt, c := newRecordingTwilio(t, `{"sid":"`+originatedCallSID+`"}`)
	ctx := context.Background()
	sid, err := c.PlaceCall(ctx, PlaceCallParams{To: aLegDestination, From: "+14155551234", TwiML: "<Response/>", TimeLimitSeconds: 300})
	if err != nil || sid != originatedCallSID {
		t.Fatalf("%q %v", sid, err)
	}
	if !strings.HasSuffix(rt.paths[0], "/Accounts/ACtest/Calls.json") || rt.forms[0].Get("TimeLimit") != "300" ||
		rt.forms[0].Get("Twiml") != "<Response/>" || rt.forms[0].Has("Record") {
		t.Fatalf("%s %v", rt.paths[0], rt.forms[0])
	}
	if rt.auth[0] != "Basic QUN0ZXN0OnNlY3JldA==" {
		t.Fatalf("auth %q", rt.auth[0])
	}
	if _, err := c.PlaceCall(ctx, PlaceCallParams{To: "+14155557777", From: "+14155551234", TwiML: "<Response/>", Record: true}); err != nil {
		t.Fatal(err)
	}
	if rt.forms[1].Has("TimeLimit") || rt.forms[1].Get("Record") != "true" {
		t.Fatalf("%v", rt.forms[1])
	}
	if err := c.EndCall(ctx, originatedCallSID); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(rt.paths[2], "/Calls/"+originatedCallSID+".json") || rt.forms[2].Get("Status") != "completed" {
		t.Fatalf("%s %v", rt.paths[2], rt.forms[2])
	}
}

func TestRESTNumbersDTMFAndErrors(t *testing.T) {
	rt, c := newRecordingTwilio(t, `{"incoming_phone_numbers":[{"sid":"PNabc"}],"voice_url":"https://prior"}`)
	ctx := context.Background()
	if sid, err := c.ResolvePhoneNumberSID(ctx, "+14155551234"); err != nil || sid != "PNabc" {
		t.Fatalf("%q %v", sid, err)
	}
	if !strings.Contains(rt.paths[0], "/IncomingPhoneNumbers.json?PageSize=1&PhoneNumber=%2B14155551234") {
		t.Fatalf("path %s", rt.paths[0])
	}
	if u, err := c.ReadVoiceURL(ctx, "PNabc"); err != nil || u != "https://prior" {
		t.Fatalf("%q %v", u, err)
	}
	if err := c.WriteVoiceURL(ctx, "PNabc", "https://new/twilio/voice"); err != nil || rt.forms[2].Get("VoiceUrl") != "https://new/twilio/voice" {
		t.Fatalf("%v %v", err, rt.forms[2])
	}
	if err := c.SendDTMF(ctx, "CA1", "12#"); err != nil || rt.forms[3].Get("Twiml") != `<Response><Play digits="12#"/></Response>` {
		t.Fatalf("%v %v", err, rt.forms[3])
	}
	if err := c.SendDTMF(ctx, "CA1", `1"/>`); err == nil || len(rt.paths) != 4 {
		t.Fatal("invalid DTMF reached the wire")
	}
	err := c.EndCall(ctx, "fail")
	if err == nil || !strings.Contains(err.Error(), "Twilio REST POST /Calls/fail.json failed: HTTP 429") || !strings.Contains(err.Error(), "rate limited") {
		t.Fatalf("err %v", err)
	}
	_, c = newRecordingTwilio(t, `{"incoming_phone_numbers":[]}`)
	if _, err := c.ResolvePhoneNumberSID(ctx, "+14155551234"); err == nil || !strings.Contains(err.Error(), "No incoming phone number") {
		t.Fatalf("err %v", err)
	}
	_, c = newRecordingTwilio(t, `{}`)
	if _, err := c.PlaceCall(ctx, PlaceCallParams{}); err == nil || !strings.Contains(err.Error(), "returned no sid") {
		t.Fatalf("err %v", err)
	}
}
