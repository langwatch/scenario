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

// AgentNonBlocking routes the turn and takes the agent's input before it
// returns: a barge-in the script sends next is neither part of the input
// nor shares the agent's turn.
func TestAgentNonBlockingRoutesBeforeReturning(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	var seen []string
	agent := AgentFunc(func(_ context.Context, in AgentInput) (*AgentReturn, error) {
		for _, m := range in.Messages {
			seen = append(seen, m.Content)
		}
		<-release
		return TextReturn("reply"), nil
	})
	sim, _ := userSim("x")
	var turns []int
	cfg := baseConfig(agent, sim)
	cfg.Script = []ScriptStep{
		User("first"),
		StepFunc(func(ctx context.Context, ex *Executor) error {
			ex.AgentNonBlocking(ctx)
			turns = append(turns, ex.state.CurrentTurn())
			return nil
		}),
		User("barge"),
		StepFunc(func(ctx context.Context, ex *Executor) error {
			turns = append(turns, ex.state.CurrentTurn())
			close(release)
			return ex.PendingAgentTurn().Wait()
		}),
		Succeed(),
	}
	res, err := Run(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(seen, []string{"first"}) {
		t.Fatalf("agent input %v, want [first]", seen)
	}
	if !slices.Equal(turns, []int{0, 1}) {
		t.Fatalf("turns %v, want the barge-in on the next turn [0 1]", turns)
	}
	if len(res.Messages) != 3 || res.Messages[2].Content != "reply" {
		t.Fatalf("%+v", res.Messages)
	}
}

// verdictJudge is a judge returning a passing verdict: on inline criteria
// it meets them, else it meets "final".
type verdictJudge struct{}

func (verdictJudge) Role() AgentRole { return AgentRoleJudge }
func (verdictJudge) Call(_ context.Context, in AgentInput) (*AgentReturn, error) {
	met := []string{"final"}
	if in.JudgmentRequest != nil && in.JudgmentRequest.Criteria != nil {
		met = in.JudgmentRequest.Criteria
	}
	return VerdictReturn(JudgeResult{Success: true, Reasoning: "ok", MetCriteria: met}), nil
}

// A non-blocking turn ending after the final verdict does not merge the
// checkpoint criteria into the result a second time.
func TestNonBlockingTurnDoesNotMergeCheckpointsAgain(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	agent := AgentFunc(func(context.Context, AgentInput) (*AgentReturn, error) {
		<-release
		return TextReturn("late"), nil
	})
	sim, _ := userSim("x")
	cfg := baseConfig(agent, sim, verdictJudge{})
	cfg.Script = []ScriptStep{
		User("hi"),
		Judge(WithCriteria("cp")),
		StepFunc(func(ctx context.Context, ex *Executor) error {
			ex.AgentNonBlocking(ctx)
			_, err := ex.Judge(ctx, JudgmentRequest{})
			close(release)
			if err != nil {
				return err
			}
			return ex.PendingAgentTurn().Wait()
		}),
	}
	res, err := Run(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(res.MetCriteria, []string{"cp", "final"}) {
		t.Fatalf("met criteria %v, want [cp final]", res.MetCriteria)
	}
}
