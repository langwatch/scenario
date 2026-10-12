package ws

import (
	"context"
	"sync"
	"time"
)

// aLongTimeAgo is the past deadline that fails a blocked operation at once.
var aLongTimeAgo = time.Unix(1, 0)

// watch maps the context of one direction's operations (all reads, or all
// writes) onto that direction's connection deadline.
//
// A context's deadline is applied with SetReadDeadline/SetWriteDeadline,
// only when it differs from the one already set. Its cancellation is watched
// by one context.AfterFunc, registered when a context with a new Done
// channel arrives and kept while the caller keeps passing that context (or
// value contexts derived from it, which share its Done channel). Between
// operations a cancellation does nothing; during one it sets a past
// deadline, failing the blocked call. So a read loop or a writer on a
// session context allocates nothing per call; a fresh cancellable context
// per call costs one AfterFunc, like github.com/coder/websocket.
type watch struct {
	// set applies a deadline to the connection; bound once at construction.
	set func(time.Time) error
	// fire is w.onFire, bound once so registering it does not allocate a
	// new method value each time.
	fire func()

	mu     sync.Mutex
	done   <-chan struct{}
	stop   func() bool
	active bool
	fired  bool

	// applied is the deadline currently set on the connection. Only the
	// goroutine holding the direction's lock (Conn.readMu or Conn.writeMu)
	// touches it.
	applied time.Time
}

func (w *watch) init(set func(time.Time) error) {
	w.set = set
	w.fire = w.onFire
}

// begin prepares an operation under ctx. It returns ctx's error if ctx is
// already done, and ctx's deadline (zero for none).
func (w *watch) begin(ctx context.Context) (time.Time, error) {
	if err := ctx.Err(); err != nil {
		return time.Time{}, err
	}
	done := ctx.Done()
	dl, _ := ctx.Deadline()
	w.mu.Lock()
	if done != w.done {
		if w.stop != nil {
			w.stop()
		}
		w.done, w.stop = done, nil
		if done != nil {
			w.stop = context.AfterFunc(ctx, w.fire)
		}
	}
	w.mu.Unlock()
	// The deadline goes on before the operation is marked active, so it can
	// never overwrite the past deadline of a cancellation that fires now.
	if !dl.Equal(w.applied) {
		w.applied = dl
		_ = w.set(dl)
	}
	w.mu.Lock()
	w.active, w.fired = true, false
	w.mu.Unlock()
	// A cancellation between the first check and active=true found nothing
	// to fail; catch it here. Any later one sees active.
	if err := ctx.Err(); err != nil {
		w.end()
		return time.Time{}, err
	}
	return dl, nil
}

// end finishes the operation and reports whether a cancellation fired
// during it. A cancellation that fired after the operation had in fact
// completed leaves a past deadline on the connection, so the applied
// deadline is restored.
func (w *watch) end() bool {
	w.mu.Lock()
	fired := w.fired
	w.active, w.fired = false, false
	w.mu.Unlock()
	if fired {
		_ = w.set(w.applied)
	}
	return fired
}

// onFire runs when the watched context is cancelled. It runs on its own
// goroutine, so it can be late: by the time it holds mu, begin may have
// replaced the context and started an operation under one that has not
// ended. It fails the operation only when the context watched now is done.
func (w *watch) onFire() {
	w.mu.Lock()
	defer w.mu.Unlock()
	select {
	case <-w.done:
	default:
		return // a stale callback of a context no longer watched
	}
	if w.active {
		w.fired = true
		_ = w.set(aLongTimeAgo)
	}
}

// release drops the registration, so a closed connection does not keep a
// long-lived context's callback list growing.
func (w *watch) release() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stop != nil {
		w.stop()
	}
	w.done, w.stop = nil, nil
}

// opError maps the error of an operation that ran under ctx: a failure
// caused by ctx ending (cancellation, or its deadline as a connection
// deadline) is reported as ctx's error.
func opError(ctx context.Context, dl time.Time, fired bool, err error) error {
	if err == nil {
		return nil
	}
	if cerr := ctx.Err(); cerr != nil {
		return cerr
	}
	if fired {
		return context.Canceled
	}
	if !dl.IsZero() && !time.Now().Before(dl) {
		return context.DeadlineExceeded
	}
	return err
}
