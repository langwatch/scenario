package scenario

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
)

// A non-blocking turn replaced by a later one is still drained before the
// run finishes, and its error still fails the run.
func TestOverlappingNonBlockingTurnsAreAllDrained(t *testing.T) {
	t.Parallel()
	started := make(chan struct{})
	release := make(chan struct{})
	var calls, finished atomic.Int32
	agent := AgentFunc(func(context.Context, AgentInput) (*AgentReturn, error) {
		if calls.Add(1) == 1 {
			close(started)
			<-release
			finished.Add(1)
			return nil, errors.New("first turn failed late")
		}
		finished.Add(1)
		return TextReturn("second"), nil
	})
	rec := &eventRecorder{}
	cfg := baseConfig(agent)
	cfg.Script = []ScriptStep{StepFunc(func(ctx context.Context, ex *Executor) error {
		ex.AgentNonBlocking(ctx)
		<-started
		if err := ex.AgentNonBlocking(ctx).Wait(); err != nil {
			return err
		}
		close(release)
		return nil
	})}
	_, err := Run(context.Background(), cfg, WithEventListener(rec.record))
	if err == nil || !strings.Contains(err.Error(), "first turn failed late") {
		t.Fatalf("got %v", err)
	}
	if finished.Load() != 2 {
		t.Fatalf("run ended with %d of 2 turns finished", finished.Load())
	}
	events := rec.all()
	if last := events[len(events)-1]; last.Type != EventRunFinished {
		t.Fatalf("last event %s", last.Type)
	}
}

// A panic in a non-blocking turn fails the run instead of crashing the
// process.
func TestNonBlockingTurnPanicFailsRun(t *testing.T) {
	t.Parallel()
	agent := AgentFunc(func(context.Context, AgentInput) (*AgentReturn, error) { panic("kaboom") })
	cfg := baseConfig(agent)
	cfg.Script = []ScriptStep{StepFunc(func(ctx context.Context, ex *Executor) error { ex.AgentNonBlocking(ctx); return nil })}
	res, err := Run(context.Background(), cfg)
	if err == nil || !strings.Contains(err.Error(), "kaboom") || res == nil || res.Success {
		t.Fatalf("%+v %v", res, err)
	}
}

// A turn an extension took over reports its error through the extension,
// not a second time at the end of the run.
func TestTakenNonBlockingTurnErrorIsNotReportedTwice(t *testing.T) {
	t.Parallel()
	agent := AgentFunc(func(context.Context, AgentInput) (*AgentReturn, error) { return nil, errors.New("handled") })
	cfg := baseConfig(agent)
	cfg.Script = []ScriptStep{StepFunc(func(ctx context.Context, ex *Executor) error {
		ex.AgentNonBlocking(ctx)
		_ = ex.TakePendingAgentTurn().Wait() // the extension handles it
		return nil
	}), Succeed()}
	res, err := Run(context.Background(), cfg)
	if err != nil || !res.Success {
		t.Fatalf("%+v %v", res, err)
	}
}

// A verdict reached while a non-blocking turn is in flight still returns
// the message that turn added.
func TestResultIncludesDrainedTurnMessages(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	agent := AgentFunc(func(context.Context, AgentInput) (*AgentReturn, error) {
		<-release
		return TextReturn("late reply"), nil
	})
	cfg := baseConfig(agent)
	cfg.Script = []ScriptStep{StepFunc(func(ctx context.Context, ex *Executor) error {
		ex.AgentNonBlocking(ctx)
		ex.Succeed(ctx, "")
		close(release)
		return nil
	})}
	res, err := Run(context.Background(), cfg)
	if err != nil || len(res.Messages) != 1 || res.Messages[0].Content != "late reply" {
		t.Fatalf("%+v %v", res, err)
	}
}
