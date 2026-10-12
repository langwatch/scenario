package mediastream

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/langwatch/scenario/go/voice/audio"
)

// ErrTakeTimeout is returned by [Queue.Take] when nothing arrived in time.
var ErrTakeTimeout = errors.New("mediastream: no chunk within the timeout")

// Queue is the inbound chunk queue between a background receive loop
// (producer) and ReceiveAudio (consumer). Take waits with a timeout; a
// parked consumer is handed the next chunk directly. It is safe for
// concurrent use.
type Queue struct {
	mu      sync.Mutex
	items   []audio.Chunk
	head    int
	waiters []chan taken
}

type taken struct {
	c   audio.Chunk
	err error
}

// Put hands c to the oldest parked consumer, or buffers it.
func (q *Queue) Put(c audio.Chunk) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.waiters) > 0 {
		w := q.waiters[0]
		q.waiters = q.waiters[1:]
		w <- taken{c: c}
		return
	}
	if q.head > 0 && q.head*2 >= len(q.items) {
		// Compact once the consumed prefix dominates, so a long call does not
		// grow the backing array without bound.
		n := copy(q.items, q.items[q.head:])
		clear(q.items[n:])
		q.items, q.head = q.items[:n], 0
	}
	q.items = append(q.items, c)
}

// Len is the number of buffered chunks.
func (q *Queue) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.items) - q.head
}

// HasAudio reports whether a buffered chunk carries audio, as opposed to
// only empty end-of-stream chunks.
func (q *Queue) HasAudio() bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, c := range q.items[q.head:] {
		if len(c.Data) > 0 {
			return true
		}
	}
	return false
}

// Clear drops the buffered chunks; parked consumers keep waiting.
func (q *Queue) Clear() {
	q.mu.Lock()
	defer q.mu.Unlock()
	clear(q.items)
	q.items, q.head = q.items[:0], 0
}

// Fail drops the buffered chunks and fails every parked consumer with err.
func (q *Queue) Fail(err error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	clear(q.items)
	q.items, q.head = q.items[:0], 0
	q.release(taken{err: err})
}

// FailWaiters fails every parked consumer with err and keeps the buffered
// chunks for later takes.
func (q *Queue) FailWaiters(err error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.release(taken{err: err})
}

// Wake hands c to every parked consumer without buffering it.
func (q *Queue) Wake(c audio.Chunk) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.release(taken{c: c})
}

func (q *Queue) release(t taken) {
	for _, w := range q.waiters {
		w <- t
	}
	clear(q.waiters)
	q.waiters = q.waiters[:0]
}

// Take returns the next chunk, waiting up to timeout. It returns
// ErrTakeTimeout when none arrived, ctx's error when ctx ended first.
func (q *Queue) Take(ctx context.Context, timeout time.Duration) (audio.Chunk, error) {
	q.mu.Lock()
	if q.head < len(q.items) {
		c := q.items[q.head]
		q.items[q.head] = audio.Chunk{}
		q.head++
		q.mu.Unlock()
		return c, nil
	}
	w := make(chan taken, 1)
	q.waiters = append(q.waiters, w)
	q.mu.Unlock()

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	var err error
	select {
	case t := <-w:
		return t.c, t.err
	case <-timer.C:
		err = ErrTakeTimeout
	case <-ctx.Done():
		err = ctx.Err()
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	for i, x := range q.waiters {
		if x == w {
			q.waiters = append(q.waiters[:i], q.waiters[i+1:]...)
			return audio.Chunk{}, err
		}
	}
	// A producer handed us a chunk as we gave up: it is ours.
	t := <-w
	return t.c, t.err
}
