package scenario

import (
	"context"
	"errors"
	"slices"
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

// A rollback or ClearPendingMessages while a non-blocking turn runs,
// followed by a broadcast, must not make the executor drop the broadcast
// message the agent never saw from its queue.
func TestQueueChangesDuringAgentCallKeepUndeliveredMessages(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name   string
		change func(ex *Executor, agent AgentAdapter)
	}{
		{"rollback", func(ex *Executor, _ AgentAdapter) {
			if _, err := ex.state.RollbackMessagesTo(1); err != nil {
				panic(err)
			}
		}},
		{"clear", func(ex *Executor, agent AgentAdapter) { ex.ClearPendingMessages(agent) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			started := make(chan struct{})
			release := make(chan struct{})
			var calls atomic.Int32
			var second []string
			// A pointer, so ClearPendingMessages can compare it.
			agent := &struct{ AgentFunc }{func(_ context.Context, in AgentInput) (*AgentReturn, error) {
				if calls.Add(1) == 1 {
					close(started)
					<-release
					return TextReturn("first"), nil
				}
				for _, m := range in.NewMessages {
					second = append(second, m.Content)
				}
				return TextReturn("second"), nil
			}}
			cfg := baseConfig(agent)
			cfg.Script = []ScriptStep{StepFunc(func(ctx context.Context, ex *Executor) error {
				ex.AddMessage(Message{Role: RoleUser, Content: "x"})
				ex.AddMessage(Message{Role: RoleUser, Content: "y"})
				turn := ex.AgentNonBlocking(ctx)
				<-started
				tc.change(ex, agent)
				ex.AddMessage(Message{Role: RoleUser, Content: "z"})
				ex.AddMessage(Message{Role: RoleUser, Content: "w"})
				close(release)
				if err := turn.Wait(); err != nil {
					return err
				}
				return ex.AgentNonBlocking(ctx).Wait()
			}), Succeed()}
			if _, err := Run(context.Background(), cfg); err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(second, []string{"z", "w"}) {
				t.Fatalf("second call got new messages %v, want [z w]", second)
			}
		})
	}
}
