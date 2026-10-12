package scenario

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testEvent(seq int) Event {
	return Event{Type: EventMessageSnapshot, Seq: uint64(seq), ScenarioRunID: "r", Payload: []byte(`{"seq":` + strconv.Itoa(seq) + `}`)}
}

func TestReporterAuthHeaders(t *testing.T) {
	cs := newCapturingServer(t)
	r := newEventReporter(LangWatchConfig{Endpoint: cs.URL + "/ignored/path", APIKey: "pat-lw-key", ProjectID: "proj_1"})
	r.postWithRetry(context.Background(), testEvent(1))
	h := cs.headers[0]
	if h.Get("Authorization") != "Bearer pat-lw-key" || h.Get("X-Project-Id") != "proj_1" || h.Get("Content-Type") != "application/json" {
		t.Fatalf("headers %v", h)
	}
	r2 := newEventReporter(LangWatchConfig{Endpoint: cs.URL, APIKey: "sk-lw-key"})
	r2.postWithRetry(context.Background(), testEvent(2))
	if _, ok := cs.headers[1]["X-Project-Id"]; ok {
		t.Fatal("no X-Project-Id without a project id")
	}
}

func TestReporterRetryPolicy(t *testing.T) {
	cases := []struct {
		status   int
		attempts int
	}{
		{http.StatusInternalServerError, 3},
		{http.StatusTooManyRequests, 3},
		{http.StatusRequestTimeout, 3},
		{http.StatusBadRequest, 1},
		{http.StatusUnauthorized, 1},
	}
	for _, c := range cases {
		cs := newCapturingServer(t)
		cs.fail = func(int, []byte) int { return c.status }
		r := newEventReporter(cs.langwatch())
		r.retryBase = time.Millisecond
		r.postWithRetry(context.Background(), testEvent(1))
		if got := len(cs.posted()); got != c.attempts {
			t.Errorf("status %d: %d attempts, want %d", c.status, got, c.attempts)
		}
	}
}

func TestReporterRetrySucceedsWithIdenticalBody(t *testing.T) {
	cs := newCapturingServer(t)
	cs.fail = func(n int, _ []byte) int {
		if n < 3 {
			return http.StatusBadGateway
		}
		return 0
	}
	r := newEventReporter(cs.langwatch())
	r.retryBase = time.Millisecond
	r.postWithRetry(context.Background(), testEvent(7))
	b := cs.posted()
	if len(b) != 3 || !bytes.Equal(b[0], b[2]) {
		t.Fatalf("retries must post the identical body: %q", b)
	}
}

func TestEventBusDeliversInOrderWithoutDropping(t *testing.T) {
	cs := newCapturingServer(t)
	var slow atomic.Int32
	cs.fail = func(n int, _ []byte) int {
		if slow.Add(1)%50 == 0 {
			time.Sleep(5 * time.Millisecond)
		}
		return 0
	}
	d := &eventDelivery{reporter: newEventReporter(cs.langwatch())}
	bus := newEventBus(d.deliver)
	const n = 500
	for i := 1; i <= n; i++ {
		bus.publish(testEvent(i)) // never blocks
	}
	bus.drain(time.Minute)
	got := cs.posted()
	if len(got) != n {
		t.Fatalf("delivered %d of %d", len(got), n)
	}
	for i, b := range got {
		var v struct{ Seq int }
		json.Unmarshal(b, &v)
		if v.Seq != i+1 {
			t.Fatalf("out of order at %d: %s", i, b)
		}
	}
}

func TestReporterDisabledWithoutKey(t *testing.T) {
	rec := &eventRecorder{}
	d := &eventDelivery{reporter: newEventReporter(LangWatchConfig{Endpoint: "http://127.0.0.1:1"}), listener: rec.record}
	bus := newEventBus(d.deliver)
	bus.publish(testEvent(1))
	bus.drain(time.Second)
	if len(rec.all()) != 1 {
		t.Fatal("listener must still see events")
	}
}

func TestRedactedEventSummary(t *testing.T) {
	payload := []byte(`{"data":"` + strings.Repeat("QUJD", 100) + `==","x":1}`)
	got := redactedEventSummary(payload)
	if got != `{"data":"<audio:402 b64 chars elided>","x":1}` {
		t.Fatalf("got %s", got)
	}
	long := redactedEventSummary(bytes.Repeat([]byte("a,"), 2000))
	if !strings.HasSuffix(long, "(4000 chars, truncated)") {
		t.Fatalf("got %s", long[len(long)-40:])
	}
}

func TestEnvFlagParsing(t *testing.T) {
	for v, want := range map[string]bool{"true": true, "1": true, "YES": true, "on": true, "false": false, "0": false, "": false, "no": false} {
		t.Setenv("SCENARIO_TEST_FLAG", v)
		if envFlag("SCENARIO_TEST_FLAG") != want {
			t.Errorf("%q", v)
		}
	}
}
