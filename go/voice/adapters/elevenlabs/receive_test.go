package elevenlabs

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/langwatch/scenario/go/voice"
)

// The receive has two deadlines: an idle one every inbound frame re-arms
// (only turn activity once the agent spoke), and an absolute ceiling of
// max(timeout, floor) nothing re-arms. Each names its own diagnosis.
//
// The JavaScript suite runs these on fake timers at their real 45/60 s
// budgets. Here the ceiling floor is scaled down per test (the 45 s floor
// becomes about a second) and the budgets with it, so the suite runs in real
// time.

const docsAnchor = "https://scenario.langwatch.ai/voice/troubleshooting#receiveaudio-timed-out-hosted-elevenlabs"

var pcm8 = []byte("\x12\x34\x12\x34\x12\x34\x12\x34")

type pending struct {
	done  chan struct{}
	chunk voice.AudioChunk
	err   error
}

// receive starts a ReceiveAudio and returns its pending result.
func receive(ctx context.Context, tr *Transport, timeout time.Duration) *pending {
	p := &pending{done: make(chan struct{})}
	go func() {
		p.chunk, p.err = tr.ReceiveAudio(ctx, timeout)
		close(p.done)
	}()
	return p
}

// settled reports whether the receive ended, and its error.
func (p *pending) settled() (bool, error) {
	select {
	case <-p.done:
		return true, p.err
	default:
		return false, nil
	}
}

func (p *pending) wait(t *testing.T) (voice.AudioChunk, error) {
	t.Helper()
	select {
	case <-p.done:
		return p.chunk, p.err
	case <-time.After(5 * time.Second):
		t.Fatal("receive never ended")
		return voice.AudioChunk{}, nil
	}
}

// parked waits until n receivers wait on tr.
func parked(t *testing.T, tr *Transport, n int) {
	t.Helper()
	waitFor(t, func() bool { tr.mu.Lock(); defer tr.mu.Unlock(); return len(tr.waiters) == n }, "the parked receiver")
}

// stream emits frame every every for total, stopping early once the
// session is gone.
func stream(f *fakeConvAI, frame map[string]any, every, total time.Duration) {
	data, _ := json.Marshal(frame)
	for elapsed := time.Duration(0); elapsed < total; elapsed += every {
		if f.tryEmit(data) != nil {
			return
		}
		time.Sleep(every)
	}
}

func connectedWithFloor(t *testing.T, floor time.Duration) (*fakeConvAI, *Transport) {
	t.Helper()
	f := newFake(t)
	tr := must(New(f.options("agt-receive-timeout")))
	tr.ceilingFloor = floor
	if err := tr.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tr.Disconnect(context.Background()) })
	<-f.connected
	f.waitFor(func() bool { return len(f.frames()) > 0 }, "the handshake")
	return f, tr
}

// agentSpeaks delivers one chunk to a first receive, as a turn's first
// receive takes it.
func agentSpeaks(t *testing.T, f *fakeConvAI, tr *Transport) {
	t.Helper()
	p := receive(context.Background(), tr, time.Second)
	parked(t, tr, 1)
	f.emit(audioEvent(pcm8, 1))
	if _, err := p.wait(t); err != nil {
		t.Fatal(err)
	}
}

func TestReceiveTimeoutBudgetAndDiagnosis(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	t.Run("resolves for an agent answering late inside the budget", func(t *testing.T) {
		t.Parallel()
		f, tr := connectedWithFloor(t, 450*time.Millisecond)
		p := receive(ctx, tr, 600*time.Millisecond)
		time.Sleep(350 * time.Millisecond) // the JS 35 s inside 60 s
		if done, err := p.settled(); done {
			t.Fatalf("ended before its budget: %v", err)
		}
		f.emit(audioEvent(pcm8))
		if c, err := p.wait(t); err != nil || len(c.Data) == 0 {
			t.Fatalf("chunk %v err %v", c.Data, err)
		}
	})

	t.Run("names the idle deadline when the agent is silent", func(t *testing.T) {
		t.Parallel()
		_, tr := connectedWithFloor(t, 450*time.Millisecond)
		// Idle and ceiling are both 0.6 s here, as both are 60 s by default.
		_, err := receive(ctx, tr, 600*time.Millisecond).wait(t)
		msg := errMsg(err)
		for _, want := range []string{"receiveAudio timed out", "The idle deadline of 0.6s elapsed", "not even a keepalive ping", "ResponseTimeout", docsAnchor} {
			if !strings.Contains(msg, want) {
				t.Fatalf("missing %q in %q", want, msg)
			}
		}
		var te *ReceiveTimeoutError
		if strings.Contains(msg, "absolute ceiling") || !errors.As(err, &te) || te.Ceiling || !errors.Is(err, voice.ErrReceiveTimeout) {
			t.Fatalf("not an idle timeout: %v", err)
		}
	})

	t.Run("names the absolute ceiling when the agent pings but never speaks", func(t *testing.T) {
		t.Parallel()
		f, tr := connectedWithFloor(t, 450*time.Millisecond)
		p := receive(ctx, tr, 600*time.Millisecond)
		parked(t, tr, 1)
		stream(f, pingEvent(1), 200*time.Millisecond, 800*time.Millisecond)
		_, err := p.wait(t)
		msg := errMsg(err)
		for _, want := range []string{"receiveAudio timed out", "The absolute ceiling of 0.6s elapsed",
			"kept sending frames, keepalive pings or transcripts, but never audio", "ResponseTimeout", docsAnchor} {
			if !strings.Contains(msg, want) {
				t.Fatalf("missing %q in %q", want, msg)
			}
		}
		if strings.Contains(msg, "The idle deadline") {
			t.Fatalf("ceiling named as idle: %q", msg)
		}
	})

	t.Run("honours a raised budget on the idle path", func(t *testing.T) {
		t.Parallel()
		_, tr := connectedWithFloor(t, 450*time.Millisecond)
		p := receive(ctx, tr, 900*time.Millisecond)
		time.Sleep(650 * time.Millisecond)
		if done, err := p.settled(); done {
			t.Fatalf("ended at the default instead of the raised budget: %v", err)
		}
		_, err := p.wait(t)
		if !strings.Contains(errMsg(err), "The idle deadline of 0.9s elapsed") {
			t.Fatalf("err %v", err)
		}
	})

	t.Run("honours a raised budget on the ceiling path", func(t *testing.T) {
		t.Parallel()
		f, tr := connectedWithFloor(t, 450*time.Millisecond)
		p := receive(ctx, tr, 900*time.Millisecond)
		parked(t, tr, 1)
		go stream(f, pingEvent(1), 300*time.Millisecond, 1200*time.Millisecond)
		time.Sleep(600 * time.Millisecond)
		if done, err := p.settled(); done {
			t.Fatalf("ended at the floor instead of the raised ceiling: %v", err)
		}
		_, err := p.wait(t)
		if !strings.Contains(errMsg(err), "The absolute ceiling of 0.9s elapsed") {
			t.Fatalf("err %v", err)
		}
	})

	t.Run("keeps a short tail probe on the ceiling floor", func(t *testing.T) {
		t.Parallel()
		f, tr := connectedWithFloor(t, 500*time.Millisecond)
		p := receive(ctx, tr, 150*time.Millisecond)
		parked(t, tr, 1)
		go stream(f, pingEvent(1), 50*time.Millisecond, 700*time.Millisecond)
		_, err := p.wait(t)
		if !strings.Contains(errMsg(err), "The absolute ceiling of 0.5s elapsed") {
			t.Fatalf("err %v", err)
		}
	})
}

var quietAgentFrames = []struct {
	name  string
	frame map[string]any
}{
	{"ping", pingEvent(7)},
	{"vad_score", map[string]any{"type": "vad_score", "vad_score_event": map[string]any{"vad_score": 0.02}}},
	{"context_usage", map[string]any{"type": "context_usage", "context_usage_event": map[string]any{"used": 120}}},
	{"agent_chat_response_part", map[string]any{"type": "agent_chat_response_part", "text_response_part": map[string]any{"text": "", "type": "stop"}}},
}

func toolRequest() map[string]any {
	return map[string]any{"type": "agent_tool_request", "agent_tool_request": map[string]any{"tool_name": "lookup_property", "tool_call_id": "t1"}}
}

func toolResponse() map[string]any {
	return map[string]any{"type": "agent_tool_response", "agent_tool_response": map[string]any{"tool_name": "lookup_property", "tool_call_id": "t1", "is_error": false}}
}

func TestTailProbeAfterTheAgentSpoke(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const probe = 300 * time.Millisecond

	for _, q := range quietAgentFrames {
		t.Run("ends on tail silence while the agent keeps sending "+q.name, func(t *testing.T) {
			t.Parallel()
			f, tr := connectedWithFloor(t, keepaliveHardCeiling)
			agentSpeaks(t, f, tr)
			p := receive(ctx, tr, probe)
			parked(t, tr, 1)
			go stream(f, q.frame, 100*time.Millisecond, time.Second)
			_, err := p.wait(t)
			if !strings.Contains(errMsg(err), "The idle deadline of 0.3s elapsed") {
				t.Fatalf("err %v", err)
			}
		})
	}

	t.Run("keeps the probe open while more agent audio arrives", func(t *testing.T) {
		t.Parallel()
		f, tr := connectedWithFloor(t, keepaliveHardCeiling)
		agentSpeaks(t, f, tr)
		p := receive(ctx, tr, probe)
		parked(t, tr, 1)
		f.emit(audioEvent(pcm8, 1))
		if c, err := p.wait(t); err != nil || len(c.Data) == 0 {
			t.Fatalf("chunk %v err %v", c.Data, err)
		}
	})

	t.Run("keeps the probe open while a server tool runs", func(t *testing.T) {
		t.Parallel()
		f, tr := connectedWithFloor(t, keepaliveHardCeiling)
		agentSpeaks(t, f, tr)
		p := receive(ctx, tr, probe)
		parked(t, tr, 1)
		f.emit(toolRequest())
		stream(f, pingEvent(7), 100*time.Millisecond, time.Second)
		if done, err := p.settled(); done {
			t.Fatalf("turn cut while the tool ran: %v", err)
		}
	})

	t.Run("keeps the probe open through a silent tool", func(t *testing.T) {
		t.Parallel()
		f, tr := connectedWithFloor(t, keepaliveHardCeiling)
		agentSpeaks(t, f, tr)
		p := receive(ctx, tr, probe)
		parked(t, tr, 1)
		f.emit(toolRequest())
		time.Sleep(time.Second)
		if done, err := p.settled(); done {
			t.Fatalf("silent tool cut by the tail probe: %v", err)
		}
	})

	t.Run("waits for a post-tool answer slower than the tail probe", func(t *testing.T) {
		t.Parallel()
		f, tr := connectedWithFloor(t, keepaliveHardCeiling)
		agentSpeaks(t, f, tr)
		p := receive(ctx, tr, probe)
		parked(t, tr, 1)
		f.emit(toolRequest())
		time.Sleep(400 * time.Millisecond)
		f.emit(toolResponse())
		stream(f, pingEvent(7), 50*time.Millisecond, 450*time.Millisecond)
		if done, err := p.settled(); done {
			t.Fatalf("turn cut before the post-tool answer: %v", err)
		}
		f.emit(audioEvent(pcm8, 2))
		if c, err := p.wait(t); err != nil || len(c.Data) == 0 {
			t.Fatalf("chunk %v err %v", c.Data, err)
		}
	})

	t.Run("returns to the tail probe once the post-tool answer started", func(t *testing.T) {
		t.Parallel()
		f, tr := connectedWithFloor(t, keepaliveHardCeiling)
		agentSpeaks(t, f, tr)
		f.emit(toolRequest())
		f.emit(toolResponse())
		answer := receive(ctx, tr, probe)
		f.emit(audioEvent(pcm8, 2))
		if _, err := answer.wait(t); err != nil {
			t.Fatal(err)
		}
		p := receive(ctx, tr, probe)
		parked(t, tr, 1)
		go stream(f, pingEvent(7), 100*time.Millisecond, time.Second)
		if _, err := p.wait(t); !strings.Contains(errMsg(err), "The idle deadline of 0.3s elapsed") {
			t.Fatalf("err %v", err)
		}
	})

	t.Run("bounds the post-tool wait when the agent never speaks again", func(t *testing.T) {
		t.Parallel()
		f, tr := connectedWithFloor(t, 600*time.Millisecond)
		agentSpeaks(t, f, tr)
		p := receive(ctx, tr, probe)
		parked(t, tr, 1)
		f.emit(toolRequest())
		f.emit(toolResponse())
		go stream(f, pingEvent(7), 100*time.Millisecond, time.Second)
		if _, err := p.wait(t); !strings.Contains(errMsg(err), "The absolute ceiling of 0.6s elapsed") {
			t.Fatalf("err %v", err)
		}
	})

	t.Run("names the frame types that kept a ceiling wait open", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		var logs logBuffer
		o := f.options("agt")
		o.Logger = logs.logger()
		tr := must(New(o))
		tr.ceilingFloor = 500 * time.Millisecond
		if err := tr.Connect(ctx); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = tr.Disconnect(ctx) })
		<-f.connected
		p := receive(ctx, tr, probe)
		parked(t, tr, 1)
		go stream(f, quietAgentFrames[1].frame, 50*time.Millisecond, 700*time.Millisecond)
		if _, err := p.wait(t); !strings.Contains(errMsg(err), "absolute ceiling") {
			t.Fatalf("err %v", err)
		}
		var entry struct {
			Msg             string         `json:"msg"`
			End             string         `json:"end"`
			AfterAgentAudio bool           `json:"afterAgentAudio"`
			FramesByType    map[string]int `json:"framesByType"`
		}
		for _, line := range strings.Split(logs.String(), "\n") {
			if strings.Contains(line, "ended on the absolute ceiling") {
				_ = json.Unmarshal([]byte(line), &entry)
			}
		}
		if entry.End != "ceiling" || entry.AfterAgentAudio || entry.FramesByType["vad_score"] < 5 {
			t.Fatalf("ceiling warning %+v in %s", entry, logs.String())
		}
	})

	t.Run("stamps the wait diagnosis on the receive span", func(t *testing.T) {
		t.Parallel()
		f, tr := connectedWithFloor(t, keepaliveHardCeiling)
		agentSpeaks(t, f, tr)
		rec := newRecorder()
		sctx, span := rec.tracer.Start(ctx, "voice.audio.receive")
		p := receive(sctx, tr, probe)
		parked(t, tr, 1)
		go stream(f, pingEvent(7), 100*time.Millisecond, time.Second)
		if _, err := p.wait(t); !strings.Contains(errMsg(err), "The idle deadline of 0.3s elapsed") {
			t.Fatalf("err %v", err)
		}
		span.End()
		attrs := rec.attrs("voice.audio.receive")
		var frames map[string]int
		_ = json.Unmarshal([]byte(attrs["voice.elevenlabs.receive_wait_frames"].AsString()), &frames)
		if attrs["voice.elevenlabs.receive_wait_end"].AsString() != "idle" ||
			attrs["voice.elevenlabs.receive_wait_ms"].AsInt64() < 300 ||
			attrs["voice.elevenlabs.receive_wait_late_ms"].AsInt64() < 0 || frames["ping"] == 0 {
			t.Fatalf("wait attributes %v", attrs)
		}
	})

	t.Run("pings re-arm the wait again once the next user turn starts", func(t *testing.T) {
		t.Parallel()
		f, tr := connectedWithFloor(t, keepaliveHardCeiling)
		agentSpeaks(t, f, tr)
		if err := tr.SendAudio(ctx, voice.AudioChunk{Data: make([]byte, 960)}); err != nil {
			t.Fatal(err)
		}
		p := receive(ctx, tr, probe)
		parked(t, tr, 1)
		stream(f, pingEvent(7), 100*time.Millisecond, time.Second)
		if done, err := p.settled(); done {
			t.Fatalf("pre-response wait cut despite pings: %v", err)
		}
	})
}

func errMsg(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
