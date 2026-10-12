package scenario

import (
	"context"
	"strconv"
	"sync"
	"testing"
)

// Messages added concurrently (a non-blocking agent turn next to the
// script) are reported in the order of their indices: END n is always the
// message at index n.
func TestConcurrentAddsReportInIndexOrder(t *testing.T) {
	t.Parallel()
	rec := &eventRecorder{}
	cfg := baseConfig(&echoAgent{text: "ok"})
	const n = 64
	cfg.Script = []ScriptStep{StepFunc(func(_ context.Context, ex *Executor) error {
		var wg sync.WaitGroup
		for i := range n {
			wg.Add(1)
			go func() {
				defer wg.Done()
				ex.AddMessage(UserMsg("m" + strconv.Itoa(i)))
			}()
		}
		wg.Wait()
		return nil
	}), Succeed()}
	if _, err := Run(context.Background(), cfg, WithEventListener(rec.record), WithGranularEventsForRun(true)); err != nil {
		t.Fatal(err)
	}
	next := 0
	for _, e := range rec.all() {
		if e.Type != EventTextMessageEnd {
			continue
		}
		if idx := decode(t, e.Payload)["messageIndex"]; idx != float64(next) {
			t.Fatalf("END #%d carries messageIndex %v", next, idx)
		}
		next++
	}
	if next != n {
		t.Fatalf("%d ENDs, want %d", next, n)
	}
}
