package openairealtime

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/langwatch/scenario/go/voice/internal/realtimetest"
)

// The response.create guard: no second response.create while the server
// streams one; the deferred request fires at the terminal event.

func setState(rt *Transport, pending int, active, deferred bool) {
	rt.mu.Lock()
	rt.pendingAudioBytes, rt.responseActive, rt.deferredResponseCreate = pending, active, deferred
	rt.mu.Unlock()
}

func countType(srv *realtimetest.Server, typ string) int { return len(srv.OfType(typ)) }

// settle gives the server's read loop time to record frames already sent.
func settle() { time.Sleep(30 * time.Millisecond) }

func TestReceiveCommitsButDefersResponseCreateWhileActive(t *testing.T) {
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{})
	connect(t, srv, a)
	rt := a.Realtime()
	setState(rt, 960, true, false)
	if _, err := rt.ReceiveAudio(context.Background(), 50*time.Millisecond); err == nil {
		t.Fatal("receive did not time out")
	}
	srv.WaitType(t, "input_audio_buffer.commit", 0)
	settle()
	if n := countType(srv, "input_audio_buffer.commit"); n != 1 {
		t.Fatalf("commits = %d", n)
	}
	if n := countType(srv, "response.create"); n != 0 {
		t.Fatalf("response.create sent while active: %d", n)
	}
}

func TestDeferredResponseCreateFiresAfterResponseDone(t *testing.T) {
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{})
	connect(t, srv, a)
	rt := a.Realtime()
	setState(rt, 960, true, false)
	done := make(chan error, 1)
	go func() {
		_, err := rt.ReceiveAudio(context.Background(), 2*time.Second)
		done <- err
	}()
	srv.WaitType(t, "input_audio_buffer.commit", 0)
	settle()
	if n := countType(srv, "response.create"); n != 0 {
		t.Fatalf("response.create before response.done: %d", n)
	}
	srv.Push(t, map[string]any{"type": "response.done"})
	srv.WaitType(t, "response.create", 0)
	srv.Push(t, map[string]any{"type": "response.created"})
	srv.Push(t, map[string]any{"type": "response.output_audio.delta", "delta": b64(make([]byte, 960)...)})
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	settle()
	if n := countType(srv, "response.create"); n != 1 {
		t.Fatalf("response.create count = %d", n)
	}
}

func TestSendTextDefersResponseCreateWhileActive(t *testing.T) {
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{})
	connect(t, srv, a)
	rt := a.Realtime()
	setState(rt, 0, true, false)
	if err := rt.SendText(context.Background(), "hello"); err != nil {
		t.Fatal(err)
	}
	srv.WaitType(t, "conversation.item.create", 0)
	settle()
	if countType(srv, "conversation.item.create") != 1 || countType(srv, "response.create") != 0 {
		t.Fatalf("frames = %v", srv.Types())
	}
	rt.mu.Lock()
	deferred := rt.deferredResponseCreate
	rt.mu.Unlock()
	if !deferred {
		t.Fatal("response.create not deferred")
	}
}

func TestServerErrorEventFailsTheReceive(t *testing.T) {
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{})
	connect(t, srv, a)
	srv.Push(t, map[string]any{"type": "error", "error": map[string]any{"message": "Conversation already has an active response in progress"}})
	_, err := a.Realtime().ReceiveAudio(context.Background(), 5*time.Second)
	if err == nil || !strings.Contains(err.Error(), "active response in progress") {
		t.Fatalf("err = %v", err)
	}
}

func TestErrorEventWithoutMessageQuotesTheErrorObject(t *testing.T) {
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{})
	connect(t, srv, a)
	srv.Push(t, map[string]any{"type": "error", "error": map[string]any{"code": "x"}})
	_, err := a.Realtime().ReceiveAudio(context.Background(), 5*time.Second)
	if err == nil || !strings.Contains(err.Error(), `server error — {"code":"x"}`) {
		t.Fatalf("err = %v", err)
	}
}

// Disconnect clears the lifecycle state, and a reconnect of the same
// instance starts clean, including the close reason (or every receive
// would fail at once).
func TestReconnectStartsClean(t *testing.T) {
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{})
	connect(t, srv, a)
	rt := a.Realtime()
	ctx := context.Background()
	setState(rt, 0, true, true)
	_ = rt.Disconnect(ctx)
	rt.mu.Lock()
	active, deferred := rt.responseActive, rt.deferredResponseCreate
	rt.mu.Unlock()
	if active || deferred {
		t.Fatal("guard flags survived the disconnect")
	}
	connect(t, srv, a)
	rt.mu.Lock()
	active, deferred, closeErr := rt.responseActive, rt.deferredResponseCreate, rt.closeErr
	rt.mu.Unlock()
	if active || deferred || closeErr != nil {
		t.Fatalf("reconnect not clean: %v %v %v", active, deferred, closeErr)
	}
	_, err := rt.ReceiveAudio(ctx, 50*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("err = %v", err)
	}
}

// Disconnect unblocks an in-flight receive at once.
func TestDisconnectFailsTheInFlightReceive(t *testing.T) {
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{})
	connect(t, srv, a)
	errc := make(chan error, 1)
	go func() {
		_, err := a.Realtime().ReceiveAudio(context.Background(), 10*time.Second)
		errc <- err
	}()
	time.Sleep(20 * time.Millisecond)
	_ = a.Realtime().Disconnect(context.Background())
	select {
	case err := <-errc:
		if err == nil {
			t.Fatal("receive succeeded")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("receive not unblocked")
	}
}

func TestAPIKeyResolution(t *testing.T) {
	t.Run("prefers OPENAI_REALTIME_API_KEY over OPENAI_API_KEY", func(t *testing.T) {
		setEnv(t, "OPENAI_API_KEY", "vk-lw-virtual", "OPENAI_REALTIME_API_KEY", "sk-real-provider")
		rt := New(Options{}).Realtime()
		if rt.apiKey != "sk-real-provider" || rt.apiKeySource != "OPENAI_REALTIME_API_KEY" {
			t.Fatalf("key = %s (%s)", rt.apiKey, rt.apiKeySource)
		}
	})
	t.Run("falls back to OPENAI_API_KEY", func(t *testing.T) {
		setEnv(t, "OPENAI_API_KEY", "sk-plain")
		rt := New(Options{}).Realtime()
		if rt.apiKey != "sk-plain" || rt.apiKeySource != "OPENAI_API_KEY" {
			t.Fatalf("key = %s (%s)", rt.apiKey, rt.apiKeySource)
		}
	})
	t.Run("an explicit key wins", func(t *testing.T) {
		setEnv(t, "OPENAI_REALTIME_API_KEY", "sk-env")
		rt := New(Options{APIKey: "sk-explicit"}).Realtime()
		if rt.apiKey != "sk-explicit" || rt.apiKeySource != "the APIKey passed to the adapter" {
			t.Fatalf("key = %s (%s)", rt.apiKey, rt.apiKeySource)
		}
	})
}
