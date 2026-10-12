package scenario

import (
	"context"
	"runtime"
	"slices"
	"testing"
)

func lastEventStatus(t *testing.T, rec *eventRecorder) (EventType, any) {
	t.Helper()
	events := rec.all()
	if len(events) == 0 {
		t.Fatal("no events")
	}
	last := events[len(events)-1]
	return last.Type, decode(t, last.Payload)["status"]
}

// A step that panics still finalizes the result, sends RUN_FINISHED and
// stops the extensions before the panic continues.
func TestPanickingStepStillFinishesRun(t *testing.T) {
	t.Parallel()
	h := &hookRecorder{}
	rec := &eventRecorder{}
	cfg := baseConfig(&echoAgent{text: "ok"})
	cfg.Extensions = []Extension{h}
	cfg.Script = []ScriptStep{StepFunc(func(context.Context, *Executor) error { panic("step blew up") })}
	func() {
		defer func() {
			if p := recover(); p != "step blew up" {
				t.Errorf("recovered %v", p)
			}
		}()
		_, _ = Run(context.Background(), cfg, WithEventListener(rec.record))
	}()
	if typ, status := lastEventStatus(t, rec); typ != EventRunFinished || status != "ERROR" {
		t.Fatalf("last event %s %v", typ, status)
	}
	if !slices.Equal(h.events, []string{"start", "finalize", "stop"}) {
		t.Fatalf("hooks %v", h.events)
	}
}

// A step that exits its goroutine, as t.FailNow does, still finishes the
// run.
func TestGoexitStepStillFinishesRun(t *testing.T) {
	t.Parallel()
	h := &hookRecorder{}
	rec := &eventRecorder{}
	cfg := baseConfig(&echoAgent{text: "ok"})
	cfg.Extensions = []Extension{h}
	cfg.Script = []ScriptStep{StepFunc(func(context.Context, *Executor) error {
		runtime.Goexit()
		return nil
	})}
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = Run(context.Background(), cfg, WithEventListener(rec.record))
	}()
	<-done
	if typ, status := lastEventStatus(t, rec); typ != EventRunFinished || status != "ERROR" {
		t.Fatalf("last event %s %v", typ, status)
	}
	if !slices.Equal(h.events, []string{"start", "finalize", "stop"}) {
		t.Fatalf("hooks %v", h.events)
	}
}
