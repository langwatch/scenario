// Package eventq is the inbound event queue of a realtime adapter: the
// socket's read loop pushes decoded events, the receive call pops them with
// a deadline. It is single-consumer and reuses its buffer and timer, so a
// receive per media frame allocates nothing.
package eventq

import (
	"context"
	"errors"
	"sync"
	"time"
)

// ErrTimeout is returned by Pop when the deadline passed with no event.
var ErrTimeout = errors.New("eventq: no event before the deadline")

// ErrWoken is returned by Pop when Wake was called: the consumer re-checks
// its own state (a close, an interrupt) before popping again.
var ErrWoken = errors.New("eventq: woken")

// Queue is a FIFO of events. Push and Wake are safe from any goroutine; Pop
// must have a single caller at a time.
type Queue[T any] struct {
	mu    sync.Mutex
	items []T
	head  int
	woken bool
	ready chan struct{}
	timer *time.Timer
}

// New returns an empty queue.
func New[T any]() *Queue[T] {
	t := time.NewTimer(time.Hour)
	t.Stop()
	return &Queue[T]{ready: make(chan struct{}, 1), timer: t}
}

// Push appends an event and wakes the consumer.
func (q *Queue[T]) Push(v T) {
	q.mu.Lock()
	q.items = append(q.items, v)
	q.mu.Unlock()
	q.signal()
}

// Wake makes the pending (or next) Pop return ErrWoken once.
func (q *Queue[T]) Wake() {
	q.mu.Lock()
	q.woken = true
	q.mu.Unlock()
	q.signal()
}

// Clear drops every queued event and a pending wake.
func (q *Queue[T]) Clear() {
	q.mu.Lock()
	clear(q.items)
	q.items, q.head, q.woken = q.items[:0], 0, false
	q.mu.Unlock()
}

// Len is the number of queued events.
func (q *Queue[T]) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.items) - q.head
}

func (q *Queue[T]) signal() {
	select {
	case q.ready <- struct{}{}:
	default:
	}
}

// tryPop takes the oldest event, or reports a pending wake.
func (q *Queue[T]) tryPop() (v T, ok, woken bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.head < len(q.items) {
		v = q.items[q.head]
		var zero T
		q.items[q.head] = zero
		q.head++
		if q.head == len(q.items) {
			q.items, q.head = q.items[:0], 0
		}
		return v, true, false
	}
	if q.woken {
		q.woken = false
		return v, false, true
	}
	return v, false, false
}

// Pop returns the oldest event, waiting until deadline. It fails with
// ErrTimeout, ErrWoken or the context's error.
func (q *Queue[T]) Pop(ctx context.Context, deadline time.Time) (T, error) {
	var zero T
	for {
		v, ok, woken := q.tryPop()
		switch {
		case ok:
			return v, nil
		case woken:
			return zero, ErrWoken
		}
		d := time.Until(deadline)
		if d <= 0 {
			return zero, ErrTimeout
		}
		q.timer.Reset(d)
		select {
		case <-q.ready:
			q.timer.Stop()
		case <-q.timer.C:
			return zero, ErrTimeout
		case <-ctx.Done():
			q.timer.Stop()
			return zero, ctx.Err()
		}
	}
}
