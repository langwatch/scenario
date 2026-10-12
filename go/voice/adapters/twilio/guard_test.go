package twilio

// Ported from twilio-destination-guard.test.ts (the a-leg allowlist and
// tunnel readiness) and twilio-dtmf-guard.test.ts.

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// fakeTunnel records when it was consulted: originationsAtProbe is how many
// calls had been originated then, proving readiness runs before dialing.
type fakeTunnel struct {
	rest                *spyREST
	err                 error
	calls               int
	originationsAtProbe int
}

func (f *fakeTunnel) WaitUntilEdgeReachable(context.Context) error {
	f.calls++
	f.originationsAtProbe = len(f.rest.places())
	return f.err
}

type guardFixture struct {
	a      *Adapter
	rest   *spyREST
	tunnel *fakeTunnel
	base   int
}

func guarded(t *testing.T, tunnelErr error, callees ...string) *guardFixture {
	t.Helper()
	rest := newSpyREST()
	tun := &fakeTunnel{rest: rest, err: tunnelErr}
	a := connected(t, makeAdapter(t, rest, withCallees(callees...), withReadiness(tun)))
	return &guardFixture{a: a, rest: rest, tunnel: tun, base: rest.logLen()}
}

func (g *guardFixture) expectNothingDialed(t *testing.T) {
	t.Helper()
	if len(g.rest.places()) != 0 {
		t.Error("a refused destination still originated a call")
	}
	if got := g.rest.logSince(g.base); len(got) != 0 {
		t.Errorf("a refused destination still hit Twilio REST: %v", got)
	}
	if state(g.a, func(a *Adapter) string { return a.streamNonce }) != "" {
		t.Error("a refused destination still minted a nonce")
	}
}

func TestALegRefusesWhenAllowedCalleesIsUnset(t *testing.T) {
	g := guarded(t, nil)
	err := g.a.PlaceCall(context.Background(), CallOptions{To: aLegDestination, Attach: AttachALeg})
	if err == nil || !strings.Contains(err.Error(), "requires allowedCallees") || !strings.Contains(err.Error(), "***0123") {
		t.Fatalf("err %v", err)
	}
	g.expectNothingDialed(t)
}

func TestALegRefusesADestinationAbsentFromAllowedCallees(t *testing.T) {
	g := guarded(t, nil, aLegDestination)
	err := g.a.PlaceCall(context.Background(), CallOptions{To: "+14155557777", Attach: AttachALeg})
	if err == nil || !strings.Contains(err.Error(), "not in allowedCallees") {
		t.Fatalf("err %v", err)
	}
	g.expectNothingDialed(t)
}

func TestALegAllowlistedDestinationOriginates(t *testing.T) {
	g := guarded(t, nil, aLegDestination)
	if err := dialAndConnect(t, g.a, placeALeg(g.a)); err != nil {
		t.Fatal(err)
	}
	if p := g.rest.places(); len(p) != 1 || p[0].To != aLegDestination {
		t.Fatalf("places %+v", p)
	}
	if g.tunnel.calls != 1 || g.tunnel.originationsAtProbe != 0 {
		t.Fatalf("probe calls %d, originations at probe %d", g.tunnel.calls, g.tunnel.originationsAtProbe)
	}
}

func TestNearMissDestinationsAreRefused(t *testing.T) {
	for name, c := range map[string][2]string{
		"to-is-prefix":    {aLegDestination, "+4477009001"},
		"to-is-suffix":    {aLegDestination, "+7700900123"},
		"entry-is-prefix": {"+4477009001", aLegDestination},
	} {
		t.Run(name, func(t *testing.T) {
			g := guarded(t, nil, c[0])
			err := g.a.PlaceCall(context.Background(), CallOptions{To: c[1], Attach: AttachALeg})
			if err == nil || !strings.Contains(err.Error(), "not in allowedCallees") {
				t.Fatalf("err %v", err)
			}
			g.expectNothingDialed(t)
		})
	}
}

func TestNonE164AllowedCalleeIsRejectedAtConstruction(t *testing.T) {
	_, err := New(Options{PhoneNumber: "+14155551234", AllowedCallees: []string{"447700900123"}})
	if err == nil || !strings.Contains(err.Error(), "E.164") {
		t.Fatalf("err %v", err)
	}
}

func TestBLegIgnoresAllowlistAndTunnel(t *testing.T) {
	g := guarded(t, errors.New("edge did not resolve"))
	if err := dialAndConnect(t, g.a, placeBLeg(g.a)); err != nil {
		t.Fatal(err)
	}
	if p := g.rest.places(); len(p) != 1 || p[0].To != "+14155557777" || g.tunnel.calls != 0 {
		t.Fatalf("places %+v, probes %d", p, g.tunnel.calls)
	}
}

func TestUnreachableTunnelRefusesBeforeOrigination(t *testing.T) {
	g := guarded(t, errors.New("edge did not resolve"), aLegDestination)
	err := g.a.PlaceCall(context.Background(), CallOptions{To: aLegDestination, Attach: AttachALeg})
	var nr *TunnelNotReadyError
	if !errors.As(err, &nr) || !strings.Contains(err.Error(), "not reachable from the edge") ||
		!strings.Contains(errors.Unwrap(err).Error(), "edge did not resolve") {
		t.Fatalf("err %v", err)
	}
	if g.tunnel.calls != 1 {
		t.Fatalf("probes %d", g.tunnel.calls)
	}
	g.expectNothingDialed(t)

	// A probe that already says "not ready" is passed through as is.
	g = guarded(t, &TunnelNotReadyError{Msg: "own message"}, aLegDestination)
	if err := g.a.PlaceCall(context.Background(), CallOptions{To: aLegDestination, Attach: AttachALeg}); err == nil || err.Error() != "own message" {
		t.Fatalf("err %v", err)
	}
}

func TestAllowlistIsCheckedBeforeTheTunnel(t *testing.T) {
	g := guarded(t, errors.New("edge did not resolve"), aLegDestination)
	err := g.a.PlaceCall(context.Background(), CallOptions{To: "+14155557777", Attach: AttachALeg})
	if err == nil || !strings.Contains(err.Error(), "not in allowedCallees") || g.tunnel.calls != 0 {
		t.Fatalf("err %v probes %d", err, g.tunnel.calls)
	}
	g.expectNothingDialed(t)
}

func TestALegSendDTMFIsRefused(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	nonce, call := startALegCall(t, a, rest)
	ws := newConn(startFrame(startOpts{nonce: nonce}))
	drive(t, a, ws, false)
	if err := await(t, call); err != nil {
		t.Fatal(err)
	}
	err := a.SendDTMF(context.Background(), "123")
	if err == nil || err.Error() != ALegSendDTMFUnsupported || !strings.Contains(ALegSendDTMFUnsupported, "<Connect><Stream>") {
		t.Fatalf("err %v", err)
	}
	if len(rest.dtmf()) != 0 || ws.closed() || streamConnOf(a) != any(ws) {
		t.Fatal("the refusal touched the call")
	}
}

func TestBLegSendDTMFReachesREST(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	call := result(placeBLeg(a))
	waitUntil(t, func() bool { return len(rest.places()) > 0 }, "origination")
	fireConnected(a)
	if err := await(t, call); err != nil {
		t.Fatal(err)
	}
	if err := a.SendDTMF(context.Background(), "123"); err != nil {
		t.Fatal(err)
	}
	if got := rest.dtmf(); len(got) != 1 || got[0] != [2]string{originatedCallSID, "123"} {
		t.Fatalf("dtmf %v", got)
	}
}
