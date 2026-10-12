package voice

import (
	"context"
	"time"
)

// Clock is the time source of the voice runtime: wall-clock offsets for
// latency and VAD events, and the waits of the voice steps. Tests inject a
// virtual clock through Config.Clock.
type Clock interface {
	Now() time.Time
	// Sleep waits d, returning early with ctx's error when it is done.
	Sleep(ctx context.Context, d time.Duration) error
}

// SystemClock is the real clock.
type SystemClock struct{}

// Now implements Clock.
func (SystemClock) Now() time.Time { return time.Now() }

// Sleep implements Clock.
func (SystemClock) Sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// waitOrSleep waits for ch to close or d to elapse, whichever comes first.
func waitOrSleep(ctx context.Context, ch <-chan struct{}, d time.Duration) {
	if d <= 0 {
		return
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ch:
	case <-t.C:
	case <-ctx.Done():
	}
}

// waitForSpeech waits for the agent to start speaking, for its turn to end
// (nothing left to interrupt), or for d, whichever comes first.
func waitForSpeech(ctx context.Context, speaking, turnDone <-chan struct{}, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-speaking:
	case <-turnDone:
	case <-t.C:
	case <-ctx.Done():
	}
}
