package twilio

// Ported from twilio-stream-auth.test.ts (a-leg media-stream
// authentication) and twilio-nonce-provenance.test.ts.

import (
	"bytes"
	"context"
	"encoding/hex"
	"io"
	"regexp"
	"strings"
	"testing"

	"github.com/langwatch/scenario/go/voice"
)

func TestWrongNonceSocketIsClosedAndTheCorrectOneConnects(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	nonce, call := startALegCall(t, a, rest)

	attacker := newConn(startFrame(startOpts{nonce: "not-the-nonce"}))
	drive(t, a, attacker, false)
	if !attacker.closed() || !isPending(call) || streamConnOf(a) != nil {
		t.Fatalf("attacker closed=%v pending=%v transport=%v", attacker.closed(), isPending(call), streamConnOf(a))
	}
	genuine := newConn(startFrame(startOpts{nonce: nonce}))
	drive(t, a, genuine, false)
	if err := await(t, call); err != nil {
		t.Fatal(err)
	}
	if genuine.closed() || streamConnOf(a) != any(genuine) {
		t.Fatal("the correct-nonce socket is not the transport")
	}
}

func TestSocketConnectedBeforeArmingIsStillGated(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	early := newConn(startFrame(startOpts{}))
	early.gate = make(chan struct{})
	go func() { _ = a.mediaStreamLoop(context.Background(), early) }()

	nonce, call := startALegCall(t, a, rest)
	close(early.gate)
	waitUntil(t, early.closed, "the pre-arm socket to be closed")
	if streamConnOf(a) != nil || !isPending(call) {
		t.Fatal("the pre-arm socket was adopted un-gated")
	}
	drive(t, a, newConn(startFrame(startOpts{nonce: nonce})), false)
	if err := await(t, call); err != nil {
		t.Fatal(err)
	}
}

func TestMediaFromAnUnauthenticatedSocketIsDropped(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	nonce, call := startALegCall(t, a, rest)
	attacker := newConn(mediaFrame("MZ762", bytes.Repeat([]byte{0xff}, 160)))
	drive(t, a, attacker, false)
	if n := state(a, func(a *Adapter) int { return a.framesReceived }); n != 0 {
		t.Fatalf("un-adopted socket injected %d frames", n)
	}
	if streamConnOf(a) != nil || !isPending(call) {
		t.Fatal("un-adopted socket became the transport")
	}
	drive(t, a, newConn(startFrame(startOpts{nonce: nonce})), false)
	if err := await(t, call); err != nil {
		t.Fatal(err)
	}
}

func TestOmittedOrMalformedNonceIsARejection(t *testing.T) {
	for name, bad := range map[string]string{
		"omitted":   "",
		"non-ascii": strings.Repeat("é", StreamNonceHexLen),
		"over-long": strings.Repeat("0", StreamNonceHexLen*4),
	} {
		t.Run(name, func(t *testing.T) {
			rest := newSpyREST()
			a := connected(t, makeAdapter(t, rest))
			nonce, call := startALegCall(t, a, rest)
			ws := newConn(startFrame(startOpts{nonce: bad}))
			drive(t, a, ws, false)
			if !ws.closed() || !isPending(call) || streamConnOf(a) != nil {
				t.Fatal("a bad nonce was not rejected")
			}
			drive(t, a, newConn(startFrame(startOpts{nonce: nonce})), false)
			if err := await(t, call); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestStartFrameForAnotherCallSIDIsIgnored(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	nonce, call := startALegCall(t, a, rest)
	if a.CallSID() != originatedCallSID {
		t.Fatalf("call SID %q", a.CallSID())
	}
	stale := newConn(startFrame(startOpts{nonce: nonce, callSID: "CAsomeoneelse"}))
	drive(t, a, stale, false)
	if !isPending(call) || streamConnOf(a) != nil || stale.closed() {
		t.Fatal("a start frame for another call was not merely ignored")
	}
	drive(t, a, newConn(startFrame(startOpts{nonce: nonce})), false)
	if err := await(t, call); err != nil {
		t.Fatal(err)
	}
	if sid := state(a, func(a *Adapter) string { return a.streamSID }); sid != "MZ762" {
		t.Fatalf("stream SID %q", sid)
	}
}

func TestTwoOriginationsMintDifferentNoncesOfTheChosenShape(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	if err := dialAndConnect(t, a, placeALeg(a)); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	a.mode = modeIdle
	a.mu.Unlock()
	if err := dialAndConnect(t, a, placeALeg(a)); err != nil {
		t.Fatal(err)
	}
	var nonces []string
	for _, p := range rest.places() {
		m := nonceRE.FindStringSubmatch(p.TwiML)
		if m == nil {
			t.Fatalf("no nonce in %s", p.TwiML)
		}
		nonces = append(nonces, m[1])
	}
	if len(nonces) != 2 || nonces[0] == nonces[1] {
		t.Fatalf("nonces %v", nonces)
	}
	for _, n := range nonces {
		if len(n) != StreamNonceHexLen || !regexp.MustCompile(`^[0-9a-f]+$`).MatchString(n) {
			t.Fatalf("nonce %q", n)
		}
	}
}

// countingReader records how many bytes were drawn from it.
type countingReader struct{ n int }

func (r *countingReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = byte(r.n + i)
	}
	r.n += len(p)
	return len(p), nil
}

// The JS twin mocks node:crypto to prove provenance. Here the nonce source
// is a parameter: minting draws exactly StreamNonceBytes from it, and
// MintStreamNonce passes crypto/rand.Reader.
func TestNonceDrawsItsBytesFromTheGivenCSPRNG(t *testing.T) {
	r := &countingReader{}
	n := mintStreamNonce(r)
	if r.n != StreamNonceBytes || len(n) != StreamNonceHexLen {
		t.Fatalf("drew %d bytes, nonce %q", r.n, n)
	}
	if want := hex.EncodeToString([]byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}); n != want {
		t.Fatalf("nonce %q, want %q", n, want)
	}
	defer func() {
		if recover() == nil {
			t.Fatal("a failing CSPRNG must not yield a nonce")
		}
	}()
	mintStreamNonce(io.LimitReader(r, 3))
}

func TestAnUnauthenticatedSocketCannotClearTheTransport(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	nonce, call := startALegCall(t, a, rest)
	genuine := newConn(startFrame(startOpts{nonce: nonce}))
	drive(t, a, genuine, true)
	if err := await(t, call); err != nil {
		t.Fatal(err)
	}
	attacker := newConn()
	attacker.closeAtEnd = true
	await(t, drive(t, a, attacker, true))
	if streamConnOf(a) != any(genuine) || state(a, func(a *Adapter) string { return a.streamSID }) != "MZ762" {
		t.Fatal("an attacker socket cleared the transport")
	}
	if err := a.Interrupt(context.Background()); err != nil {
		t.Fatalf("interrupt on the live stream: %v", err)
	}
}

func TestBLegDialAfterALegDoesNotInheritTheNonce(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	if err := dialAndConnect(t, a, placeALeg(a)); err != nil {
		t.Fatal(err)
	}
	if state(a, func(a *Adapter) string { return a.streamNonce }) == "" {
		t.Fatal("a-leg minted no nonce")
	}
	if err := dialAndConnect(t, a, placeBLeg(a)); err != nil {
		t.Fatal(err)
	}
	if state(a, func(a *Adapter) string { return a.streamNonce }) != "" {
		t.Fatal("the a-leg nonce outlived its call")
	}
	ws := newConn(startFrame(startOpts{callSID: "CA99999999999999999999999999999999"}))
	drive(t, a, ws, false)
	if ws.closed() || streamConnOf(a) != any(ws) {
		t.Fatal("the b-leg socket was gated on a stale nonce")
	}
	if err := a.SendDTMF(context.Background(), "123"); err != nil {
		t.Fatal(err)
	}
	if got := rest.dtmf(); len(got) != 1 || got[0] != [2]string{a.CallSID(), "123"} {
		t.Fatalf("dtmf %v", got)
	}
}

func TestBLegMintsNoNonceAndConnectsUngated(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	call := result(placeBLeg(a))
	waitUntil(t, func() bool { return len(rest.places()) > 0 }, "origination")
	if strings.Contains(rest.places()[0].TwiML, "<Parameter") || state(a, func(a *Adapter) string { return a.streamNonce }) != "" {
		t.Fatal("b-leg carries a nonce")
	}
	ws := newConn(startFrame(startOpts{callSID: "CAsomeoneelse"}))
	drive(t, a, ws, false)
	if err := await(t, call); err != nil {
		t.Fatal(err)
	}
	if ws.closed() || streamConnOf(a) != any(ws) {
		t.Fatal("the b-leg socket did not connect")
	}
}

func TestASocketAdoptedBeforeDialingIsEvicted(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	media := mediaFrame("MZ762", bytes.Repeat([]byte{0xff}, 160))
	early := newConn(startFrame(startOpts{}))
	earlyLoop := drive(t, a, early, false)
	if streamConnOf(a) != any(early) {
		t.Fatal("the early nonceless socket did not adopt")
	}

	nonce, call := startALegCall(t, a, rest)
	if streamConnOf(a) != nil || !isPending(call) {
		t.Fatal("the stale socket stayed the transport, or the dial resolved without a genuine socket")
	}
	if !state(a, func(a *Adapter) bool { return a.maxDurCancel != nil }) {
		t.Fatal("watchdog not armed")
	}

	early.pushFrame(media)
	early.pushFrame(stopFrame)
	await(t, earlyLoop)
	if !early.closed() {
		t.Fatal("the stale socket was not closed")
	}
	if state(a, func(a *Adapter) int { return a.framesReceived }) != 0 ||
		state(a, func(a *Adapter) bool { return a.streamEnded }) ||
		!state(a, func(a *Adapter) bool { return a.maxDurCancel != nil }) {
		t.Fatal("the stale socket touched the current call")
	}

	genuine := newConn(startFrame(startOpts{nonce: nonce}))
	drive(t, a, genuine, true)
	if err := await(t, call); err != nil {
		t.Fatal(err)
	}
	if err := a.SendAudio(context.Background(), voice.AudioChunk{Data: make([]byte, 960)}); err != nil {
		t.Fatal(err)
	}
	if len(genuine.sentFrames()) == 0 || len(early.sentFrames()) != 0 {
		t.Fatal("audio went to the wrong socket")
	}
}

func TestNonceMatches(t *testing.T) {
	if NonceMatches("abc", "") || NonceMatches("abc", "abd") || NonceMatches("abc", "abcd") || !NonceMatches("abc", "abc") {
		t.Fatal("NonceMatches")
	}
}
