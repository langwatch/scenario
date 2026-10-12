package scenario

import (
	"context"
	"errors"
	"testing"
)

// ctxRecorder records whether the end-of-run hooks got a live context.
type ctxRecorder struct {
	finalizeErr, stopErr error
	finalized, stopped   bool
}

func (c *ctxRecorder) Key() string { return "ctx-recorder" }
func (c *ctxRecorder) FinalizeResult(ctx context.Context, _ *Executor, _ *ScenarioResult) error {
	c.finalized, c.finalizeErr = true, ctx.Err()
	return nil
}
func (c *ctxRecorder) Stop(ctx context.Context, _ *Executor) { c.stopped, c.stopErr = true, ctx.Err() }

// A cancelled run still gives its finalizers and Stop hooks a usable
// context, so they can clean up remote resources.
func TestCancelledRunCleansUpWithLiveContext(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	c := &ctxRecorder{}
	cfg := baseConfig(&echoAgent{text: "ok"})
	cfg.Extensions = []Extension{c}
	cfg.Script = []ScriptStep{StepFunc(func(context.Context, *Executor) error { cancel(); return nil }), Agent()}
	_, err := Run(ctx, cfg)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
	if !c.finalized || c.finalizeErr != nil || !c.stopped || c.stopErr != nil {
		t.Fatalf("finalize %v %v, stop %v %v", c.finalized, c.finalizeErr, c.stopped, c.stopErr)
	}
}
