package eventq

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestPopOrderTimeoutAndWake(t *testing.T) {
	q := New[int]()
	q.Push(1)
	q.Push(2)
	ctx := context.Background()
	for want := 1; want <= 2; want++ {
		if v, err := q.Pop(ctx, time.Now().Add(time.Second)); err != nil || v != want {
			t.Fatalf("pop = %d, %v", v, err)
		}
	}
	if _, err := q.Pop(ctx, time.Now().Add(10*time.Millisecond)); !errors.Is(err, ErrTimeout) {
		t.Fatalf("err = %v", err)
	}
	go func() { time.Sleep(10 * time.Millisecond); q.Wake() }()
	if _, err := q.Pop(ctx, time.Now().Add(5*time.Second)); !errors.Is(err, ErrWoken) {
		t.Fatalf("err = %v", err)
	}
	go func() { time.Sleep(10 * time.Millisecond); q.Push(3) }()
	if v, err := q.Pop(ctx, time.Now().Add(5*time.Second)); err != nil || v != 3 {
		t.Fatalf("pop = %d, %v", v, err)
	}
	q.Push(4)
	q.Wake()
	q.Clear()
	if q.Len() != 0 {
		t.Fatal("not cleared")
	}
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := q.Pop(cctx, time.Now().Add(time.Second)); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
}

func TestPopDoesNotAllocate(t *testing.T) {
	q := New[int]()
	ctx := context.Background()
	deadline := time.Now().Add(time.Minute)
	allocs := testing.AllocsPerRun(100, func() {
		q.Push(1)
		if _, err := q.Pop(ctx, deadline); err != nil {
			t.Fatal(err)
		}
	})
	if allocs != 0 {
		t.Fatalf("allocs = %v", allocs)
	}
}
