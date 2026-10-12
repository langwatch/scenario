package twilio

// Disconnect restores only the voice URLs a dial actually read, and keeps
// the first value read per number, so neither a failed read nor a redial
// can leave a number pointing at the wrong webhook.

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// voiceURLBook is a stateful voice-URL store behind a spyREST: a read sees
// the last write, the way Twilio's number resource behaves.
type voiceURLBook struct {
	mu   sync.Mutex
	urls map[string]string
}

func bookedREST(initial map[string]string) (*spyREST, *voiceURLBook) {
	b := &voiceURLBook{urls: initial}
	rest := newSpyREST()
	rest.resolve = func(n string) (string, error) {
		switch n {
		case "+14155551234":
			return phoneSID, nil
		case "+14155557777":
			return "PNcallee1", nil
		default:
			return "PNcallee2", nil
		}
	}
	rest.readVoiceURL = func(sid string) (string, error) {
		b.mu.Lock()
		defer b.mu.Unlock()
		return b.urls[sid], nil
	}
	rest.writeVoiceURL = func(sid, url string) error {
		b.mu.Lock()
		defer b.mu.Unlock()
		b.urls[sid] = url
		return nil
	}
	return rest, b
}

func (b *voiceURLBook) get(sid string) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.urls[sid]
}

func voiceURLWrites(rest *spyREST, since int) []restCall {
	var out []restCall
	for _, c := range rest.logSince(since) {
		if c.op == "writeVoiceUrl" {
			out = append(out, c)
		}
	}
	return out
}

func TestFailedReadIsNotRestoredOnDisconnect(t *testing.T) {
	for _, tc := range []struct {
		name string
		dial func(a *Adapter) error
	}{
		{"b-leg", func(a *Adapter) error { return placeBLeg(a)() }},
		{"answer", func(a *Adapter) error { return a.WaitForCall(context.Background(), time.Second) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rest := newSpyREST()
			rest.readVoiceURL = func(string) (string, error) { return "", errors.New("twilio 500") }
			a := makeAdapter(t, rest)
			if err := a.Connect(context.Background()); err != nil {
				t.Fatal(err)
			}
			base := rest.logLen()
			if err := tc.dial(a); err == nil {
				t.Fatal("the dial survived a failed read")
			}
			if err := a.Disconnect(context.Background()); err != nil {
				t.Fatal(err)
			}
			if w := voiceURLWrites(rest, base); len(w) != 0 {
				t.Fatalf("Disconnect wrote a voice URL it never read: %v", w)
			}
		})
	}
}

func TestBLegRedialsRestoreEveryCalleesOriginalURL(t *testing.T) {
	rest, book := bookedREST(map[string]string{"PNcallee1": "https://one/orig", "PNcallee2": "https://two/orig"})
	a := makeAdapter(t, rest)
	if err := a.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	// Same callee twice (the second read sees our own webhook), then another.
	for _, to := range []string{"+14155557777", "+14155557777", "+14155558888"} {
		if err := dialAndConnect(t, a, placeBLeg(a, func(o *CallOptions) { o.To = to })); err != nil {
			t.Fatal(err)
		}
	}
	if got := book.get("PNcallee1"); got != "https://example.test/twilio/voice" {
		t.Fatalf("callee rewrite %q", got)
	}
	if err := a.Disconnect(context.Background()); err != nil {
		t.Fatal(err)
	}
	if one, two := book.get("PNcallee1"), book.get("PNcallee2"); one != "https://one/orig" || two != "https://two/orig" {
		t.Fatalf("restored %q and %q", one, two)
	}
}

func TestRepeatedWaitForCallRestoresTheOriginalURL(t *testing.T) {
	rest, book := bookedREST(map[string]string{phoneSID: "https://mine/orig"})
	a := makeAdapter(t, rest)
	if err := a.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := dialAndConnect(t, a, func() error { return a.WaitForCall(context.Background(), 5*time.Second) }); err != nil {
			t.Fatal(err)
		}
	}
	if err := a.Disconnect(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := book.get(phoneSID); got != "https://mine/orig" {
		t.Fatalf("restored %q", got)
	}
}

func TestEmbeddedStartFrameTimeoutDisconnects(t *testing.T) {
	c := newConn()
	a := newStream(c, StreamOptions{ConnectTimeout: 100 * time.Millisecond})
	if err := a.Connect(context.Background()); !errors.Is(err, ErrStreamConnectTimeout) {
		t.Fatalf("err %v", err)
	}
	if a.IsConnected() || !c.closed() {
		t.Fatalf("connected %v, socket closed %v", a.IsConnected(), c.closed())
	}
	if state(a, func(a *Adapter) bool { return a.connected }) {
		t.Fatal("the adapter stayed connected without a stream")
	}
	if err := a.Connect(context.Background()); err == nil {
		t.Fatal("a retried Connect reported success with no stream")
	}
	_ = a.Disconnect(context.Background())
}
