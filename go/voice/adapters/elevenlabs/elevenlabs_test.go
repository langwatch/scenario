package elevenlabs

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
)

// Compile-time contract: the transport is a voice transport with the
// optional capabilities the runtime discovers.
var (
	_ voice.Transport              = (*Transport)(nil)
	_ voice.Named                  = (*Transport)(nil)
	_ voice.ConnectionReporter     = (*Transport)(nil)
	_ voice.HangupReporter         = (*Transport)(nil)
	_ voice.TranscriptSource       = (*Transport)(nil)
	_ voice.StreamingTranscriber   = (*Transport)(nil)
	_ voice.PendingAudioReconciler = (*Transport)(nil)
	_ scenario.AgentAdapter        = (*Agent)(nil)
	_ voice.VoiceParticipant       = (*Agent)(nil)
)

func TestConnectsToTheConversationalAIEndpoint(t *testing.T) {
	t.Parallel()
	f := newFake(t)
	tr := f.connect(f.options("agt_test_123"))

	// A private agent authenticates through the signed-URL mint for its id.
	if f.signedCalls != 1 || f.lastAgentID != "agt_test_123" || f.lastAPIKey != "sk_fake" {
		t.Fatalf("signed-URL mint: calls=%d agent=%q key=%q", f.signedCalls, f.lastAgentID, f.lastAPIKey)
	}
	if want := "/convai?token=signed&source=js_sdk&version=2.64.0"; f.dialedURL != want {
		t.Fatalf("dialed %q, want %q", f.dialedURL, want)
	}
	if typ := f.frames()[0]["type"]; typ != "conversation_initiation_client_data" {
		t.Fatalf("first frame type %v", typ)
	}

	// PCM16 audio goes over the socket as user_audio_chunk frames.
	speech := []byte{0x10, 0x00, 0x20, 0x00, 0x30, 0x00, 0x40, 0x00}
	if err := tr.SendAudio(context.Background(), voice.AudioChunk{Data: speech}); err != nil {
		t.Fatal(err)
	}
	carriesSpeech := func() bool {
		for _, b := range audioFrames(f.frames()) {
			if len(b) == pumpFrameBytes && bytes.Equal(b[:len(speech)], speech) {
				return true
			}
		}
		return false
	}
	f.waitFor(carriesSpeech, "the speech frame")
	if n := len(framesOfType(f.frames(), "user_message")); n != 0 {
		t.Fatalf("a user_message text commit was sent (%d)", n)
	}
}

func TestWireProtocol(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	t.Run("decodes base64 PCM16 from an audio event for a waiting receiver", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		tr := f.connect(f.options("agt"))
		got := make(chan voice.AudioChunk, 1)
		go func() { c, _ := tr.ReceiveAudio(ctx, time.Second); got <- c }()
		waitFor(t, func() bool { tr.mu.Lock(); defer tr.mu.Unlock(); return len(tr.waiters) == 1 }, "the receiver")
		f.emit(audioEvent([]byte{0xff, 0x00, 0x10, 0x20}))
		if c := <-got; !bytes.Equal(c.Data, []byte{0xff, 0x00, 0x10, 0x20}) {
			t.Fatalf("chunk %v", c.Data)
		}
	})

	t.Run("trims an odd-byte payload to whole samples", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		tr := f.connect(f.options("agt"))
		f.emit(audioEvent([]byte{0xff, 0x00, 0x10, 0x20, 0xab}))
		c, err := tr.ReceiveAudio(ctx, time.Second)
		if err != nil || len(c.Data) != 4 {
			t.Fatalf("chunk %v err %v", c.Data, err)
		}
	})

	t.Run("queues audio that arrives before any receiver", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		tr := f.connect(f.options("agt"))
		f.emit(audioEvent([]byte{0x01, 0x02}))
		f.sync()
		c, err := tr.ReceiveAudio(ctx, 100*time.Millisecond)
		if err != nil || !bytes.Equal(c.Data, []byte{0x01, 0x02}) {
			t.Fatalf("chunk %v err %v", c.Data, err)
		}
	})

	t.Run("answers a ping with a pong echoing its event_id", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		f.connect(f.options("agt"))
		f.clearFrames()
		f.emit(map[string]any{"type": "ping", "ping_event": map[string]any{"event_id": 42, "ping_ms": 100}})
		f.waitFor(func() bool { return len(framesOfType(f.frames(), "pong")) == 1 }, "the pong")
		pong := framesOfType(f.frames(), "pong")[0]
		if !reflect.DeepEqual(pong, map[string]any{"type": "pong", "event_id": float64(42)}) {
			t.Fatalf("pong %v", pong)
		}
	})

	t.Run("captures user_transcript, agent_response and its correction", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		tr := f.connect(f.options("agt"))
		f.emit(map[string]any{"type": "user_transcript", "user_transcription_event": map[string]any{"user_transcript": " hello world "}})
		f.emit(map[string]any{"type": "agent_response", "agent_response_event": map[string]any{"agent_response": "draft text"}})
		f.sync()
		if tr.LastUserTranscript() != "hello world" || tr.LastAgentTranscript() != "draft text" {
			t.Fatalf("user %q agent %q", tr.LastUserTranscript(), tr.LastAgentTranscript())
		}
		f.emit(map[string]any{"type": "agent_response_correction", "agent_response_correction_event": map[string]any{
			"original_agent_response": "draft text", "corrected_agent_response": "post-correction text"}})
		f.sync()
		if got := tr.LastAgentTranscript(); got != "post-correction text" {
			t.Fatalf("corrected transcript %q", got)
		}
		if tr.StreamingTranscript() != "post-correction text" {
			t.Fatalf("streaming transcript %q", tr.StreamingTranscript())
		}
		tr.ResetAgentTranscript()
		if tr.LastAgentTranscript() != "" {
			t.Fatal("ResetAgentTranscript kept the transcript")
		}
	})

	t.Run("warns on audio format drift and captures the conversation id", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		var logs logBuffer
		o := f.options("agt")
		o.Logger = logs.logger()
		tr := f.connect(o)
		if tr.ConversationID() != "" {
			t.Fatal("conversation id before the metadata")
		}
		f.emit(map[string]any{"type": "conversation_initiation_metadata", "conversation_initiation_metadata_event": map[string]any{
			"conversation_id": "conv_1", "agent_output_audio_format": "mulaw_8000", "user_input_audio_format": "pcm_24000"}})
		f.sync()
		if tr.ConversationID() != "conv_1" {
			t.Fatalf("conversation id %q", tr.ConversationID())
		}
		out := logs.String()
		if strings.Count(out, `"level":"WARN"`) != 1 || !strings.Contains(out, "agent_output_audio_format=mulaw_8000") {
			t.Fatalf("drift warning: %s", out)
		}
	})

	t.Run("swallows interruption and unknown events", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		tr := f.connect(f.options("agt"))
		f.emit(map[string]any{"type": "interruption", "interruption_event": map[string]any{"event_id": "1"}})
		f.emit(map[string]any{"type": "vad_score", "vad_event": map[string]any{"score": 0.5}})
		f.emit(map[string]any{"type": "agent_response_metadata", "metadata": map[string]any{}})
		f.sync()
		if tr.LastAgentTranscript() != "" || tr.LastUserTranscript() != "" || !tr.IsConnected() {
			t.Fatal("an ignored event changed the transport")
		}
	})

	t.Run("drops audio of an interrupted response by event_id", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		tr := f.connect(f.options("agt"))
		f.emit(map[string]any{"type": "interruption", "interruption_event": map[string]any{"event_id": 5}})
		f.emit(audioEvent([]byte{1, 1}, 4))
		f.emit(audioEvent([]byte{2, 2}, 6))
		f.sync()
		c, _ := tr.ReconcilePendingAudio()
		if !bytes.Equal(c.Data, []byte{2, 2}) {
			t.Fatalf("queued audio %v, want only the post-interruption event", c.Data)
		}
	})

	t.Run("a client tool call ends a tool-only turn with an empty chunk", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		tr := f.connect(f.options("agt"))
		got := make(chan voice.AudioChunk, 1)
		go func() { c, _ := tr.ReceiveAudio(ctx, 2*time.Second); got <- c }()
		waitFor(t, func() bool { tr.mu.Lock(); defer tr.mu.Unlock(); return len(tr.waiters) == 1 }, "the receiver")
		f.emit(map[string]any{"type": "client_tool_call", "client_tool_call": map[string]any{
			"tool_name": "lookup_order", "tool_call_id": "call_1", "parameters": map[string]any{"order_id": "42"}}})
		select {
		case c := <-got:
			if len(c.Data) != 0 {
				t.Fatalf("chunk %v", c.Data)
			}
		case <-time.After(time.Second):
			t.Fatal("the receiver was not released")
		}
		// The SDK answers a tool no handler is registered for.
		f.waitFor(func() bool { return len(framesOfType(f.frames(), "client_tool_result")) == 1 }, "the tool result")
		res := framesOfType(f.frames(), "client_tool_result")[0]
		want := map[string]any{"type": "client_tool_result", "tool_call_id": "call_1",
			"result": "Tool 'lookup_order' is not registered", "is_error": true}
		if !reflect.DeepEqual(res, want) {
			t.Fatalf("tool result %v", res)
		}
	})

	t.Run("a client tool call with no receiver is not queued", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		tr := f.connect(f.options("agt"))
		f.emit(map[string]any{"type": "client_tool_call", "client_tool_call": map[string]any{"tool_name": "x", "tool_call_id": "c"}})
		f.sync()
		if _, ok := tr.ReconcilePendingAudio(); ok {
			t.Fatal("the terminal was queued")
		}
	})

	t.Run("ignores non-JSON frames", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		tr := f.connect(f.options("agt"))
		f.emitRaw("not-json")
		f.emit(map[string]any{"type": "user_transcript", "user_transcription_event": map[string]any{"user_transcript": "after junk"}})
		f.sync()
		if tr.LastUserTranscript() != "after junk" {
			t.Fatalf("transcript %q", tr.LastUserTranscript())
		}
	})

	t.Run("a dropped socket releases receivers and fails later sends", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		var logs logBuffer
		o := f.options("agt")
		o.Logger = logs.logger()
		tr := f.connect(o)
		got := make(chan voice.AudioChunk, 1)
		go func() { c, _ := tr.ReceiveAudio(ctx, 2*time.Second); got <- c }()
		waitFor(t, func() bool { tr.mu.Lock(); defer tr.mu.Unlock(); return len(tr.waiters) == 1 }, "the receiver")
		f.dropSession()
		if c := <-got; len(c.Data) != 0 {
			t.Fatalf("chunk %v", c.Data)
		}
		if err := tr.SendAudio(ctx, voice.SilentChunk(0.01)); !errors.Is(err, ErrNotConnected) {
			t.Fatalf("send after drop: %v", err)
		}
		if !strings.Contains(logs.String(), "session error") {
			t.Fatalf("no session error logged: %s", logs.String())
		}
	})

	t.Run("a socket close releases receivers", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		tr := f.connect(f.options("agt"))
		got := make(chan voice.AudioChunk, 1)
		go func() { c, _ := tr.ReceiveAudio(ctx, 2*time.Second); got <- c }()
		waitFor(t, func() bool { tr.mu.Lock(); defer tr.mu.Unlock(); return len(tr.waiters) == 1 }, "the receiver")
		f.closeSession(websocket.StatusNormalClosure)
		if c := <-got; len(c.Data) != 0 {
			t.Fatalf("chunk %v", c.Data)
		}
		waitFor(t, func() bool { return !tr.IsConnected() }, "the disconnect")
		select {
		case <-tr.pumpDone:
		case <-time.After(time.Second):
			t.Fatal("the pump outlived the session")
		}
	})

	t.Run("times out when no audio arrives", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		tr := f.connect(f.options("agt"))
		_, err := tr.ReceiveAudio(ctx, 50*time.Millisecond)
		if !errors.Is(err, voice.ErrReceiveTimeout) || !strings.Contains(err.Error(), "timed out") {
			t.Fatalf("err %v", err)
		}
	})

	t.Run("I/O before Connect fails as not connected", func(t *testing.T) {
		t.Parallel()
		tr := must(New(Options{AgentID: "agt", APIKey: "k"}))
		if err := tr.SendAudio(ctx, voice.SilentChunk(0.01)); !errors.Is(err, ErrNotConnected) {
			t.Fatalf("send: %v", err)
		}
		if _, err := tr.ReceiveAudio(ctx, time.Millisecond); !errors.Is(err, ErrNotConnected) {
			t.Fatalf("receive: %v", err)
		}
		if tr.IsConnected() {
			t.Fatal("connected before Connect")
		}
	})

	t.Run("disconnect closes the session normally", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		tr := f.connect(f.options("agt"))
		if err := tr.Disconnect(ctx); err != nil {
			t.Fatal(err)
		}
		waitFor(t, func() bool { f.mu.Lock(); defer f.mu.Unlock(); return f.closedCode != -1 }, "the close")
		if f.closedCode != websocket.StatusNormalClosure {
			t.Fatalf("close code %v", f.closedCode)
		}
	})
}

func TestMicrophonePump(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	t.Run("streams full 960-byte silence frames before any agent response", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		f.connect(f.options("agt-pump"))
		f.waitFor(func() bool { return len(audioFrames(f.frames())) >= 3 }, "three idle frames")
		for _, b := range audioFrames(f.frames()) {
			if len(b) != pumpFrameBytes || !isSilent(b) {
				t.Fatalf("idle frame of %d bytes, silent=%v", len(b), isSilent(b))
			}
		}
	})

	t.Run("pauses after the agent responds and resumes on the next user turn", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		tr := f.connect(f.options("agt-pump"))
		speech := bytes.Repeat([]byte{0x55}, 2*pumpFrameBytes)
		if err := tr.SendAudio(ctx, voice.AudioChunk{Data: speech}); err != nil {
			t.Fatal(err)
		}
		f.waitFor(func() bool {
			sawSpeech, silenceAfter := false, false
			for _, b := range audioFrames(f.frames()) {
				if !isSilent(b) {
					sawSpeech = true
				} else if sawSpeech {
					silenceAfter = true
				}
			}
			return silenceAfter
		}, "closing silence after the speech")

		f.emit(audioEvent([]byte{0x01, 0x00, 0x02, 0x00}))
		f.sync()
		paused := len(audioFrames(f.frames()))
		time.Sleep(140 * time.Millisecond) // about seven ticks
		if n := len(audioFrames(f.frames())); n != paused {
			t.Fatalf("the pump streamed %d frames into the inter-turn gap", n-paused)
		}

		if err := tr.SendAudio(ctx, voice.AudioChunk{Data: speech}); err != nil {
			t.Fatal(err)
		}
		f.waitFor(func() bool { return len(audioFrames(f.frames())) > paused }, "the next turn's frames")
	})

	t.Run("enqueues only the speech frames, with no silence tail", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		tr := f.connect(f.options("agt-pump"))
		if err := tr.SendAudio(ctx, voice.AudioChunk{Data: bytes.Repeat([]byte{0x7f}, 3*pumpFrameBytes)}); err != nil {
			t.Fatal(err)
		}
		tr.mu.Lock()
		queued := append([]byte(nil), tr.out[tr.outPos:]...)
		tr.mu.Unlock()
		// The pump may have taken one frame already.
		if n := len(queued) / pumpFrameBytes; n < 2 || n > 3 {
			t.Fatalf("%d frames queued, want the 3 speech frames", n)
		}
		for i := 0; i < len(queued); i += pumpFrameBytes {
			if isSilent(queued[i : i+pumpFrameBytes]) {
				t.Fatal("a silence-tail frame was queued")
			}
		}
	})

	t.Run("pads a partial final frame and copies the caller's PCM", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		tr := f.connect(f.options("agt-pump"))
		pcm := bytes.Repeat([]byte{0x11}, pumpFrameBytes+10)
		if err := tr.SendAudio(ctx, voice.AudioChunk{Data: pcm}); err != nil {
			t.Fatal(err)
		}
		for i := range pcm {
			pcm[i] = 0x22 // reuse by the caller must not corrupt queued frames
		}
		f.waitFor(func() bool {
			var speech [][]byte
			for _, b := range audioFrames(f.frames()) {
				if !isSilent(b) {
					speech = append(speech, b)
				}
			}
			return len(speech) == 2
		}, "two speech frames")
		var speech [][]byte
		for _, b := range audioFrames(f.frames()) {
			if !isSilent(b) {
				speech = append(speech, b)
			}
		}
		if speech[0][0] != 0x11 || speech[1][9] != 0x11 || !isSilent(speech[1][10:]) {
			t.Fatal("frames corrupted or not zero-padded")
		}
	})

	t.Run("sends no user_activity keepalive", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		f.connect(f.options("agt-pump"))
		time.Sleep(200 * time.Millisecond)
		if n := len(framesOfType(f.frames(), "user_activity")); n != 0 {
			t.Fatalf("%d user_activity frames", n)
		}
		if len(audioFrames(f.frames())) == 0 {
			t.Fatal("the pump streamed nothing")
		}
	})

	t.Run("an empty chunk is a no-op", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		tr := f.connect(f.options("agt-pump"))
		if err := tr.SendAudio(ctx, voice.AudioChunk{}); err != nil {
			t.Fatal(err)
		}
		time.Sleep(80 * time.Millisecond)
		for _, b := range audioFrames(f.frames()) {
			if !isSilent(b) {
				t.Fatal("an empty chunk streamed speech")
			}
		}
		if tr.AudioCommitCount() != 0 {
			t.Fatal("an empty chunk counted as a turn")
		}
	})

	t.Run("stamps its counters on the disconnect span", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		tr := f.connect(f.options("agt-pump"))
		f.waitFor(func() bool { return len(audioFrames(f.frames())) >= 2 }, "two frames")
		rec := newRecorder()
		sctx, span := rec.tracer.Start(ctx, "voice.adapter.disconnect")
		_ = tr.Disconnect(sctx)
		span.End()
		attrs := rec.attrs("voice.adapter.disconnect")
		if attrs["voice.elevenlabs.pump.ticks_total"].AsInt64() < 2 || attrs["voice.elevenlabs.pump.silence_frames_sent"].AsInt64() < 2 {
			t.Fatalf("pump counters %v", attrs)
		}
		if _, ok := attrs["voice.elevenlabs.pump.unexpected_errors"]; !ok {
			t.Fatal("no unexpected_errors counter")
		}
	})
}

func TestTurnCommitModes(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	t.Run("text mode sends a user_message and no audio", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		o := f.options("agt")
		o.TurnCommitMode = CommitText
		tr := f.connect(o)
		if err := tr.SendAudio(ctx, voice.AudioChunk{Data: bytes.Repeat([]byte{9}, 960), Transcript: " hi there "}); err != nil {
			t.Fatal(err)
		}
		f.waitFor(func() bool { return len(framesOfType(f.frames(), "user_message")) == 1 }, "the user_message")
		if m := framesOfType(f.frames(), "user_message")[0]; m["text"] != "hi there" {
			t.Fatalf("user_message %v", m)
		}
		for _, b := range audioFrames(f.frames()) {
			if !isSilent(b) {
				t.Fatal("text mode streamed the speech")
			}
		}
		if tr.AudioCommitCount() != 0 {
			t.Fatal("a text commit counted as an audio commit")
		}
	})

	t.Run("silence mode appends the bounded tail", func(t *testing.T) {
		t.Parallel()
		f := newFake(t)
		o := f.options("agt")
		o.TurnCommitMode = CommitSilence
		tr := f.connect(o)
		if err := tr.SendAudio(ctx, voice.AudioChunk{Data: bytes.Repeat([]byte{1}, pumpFrameBytes)}); err != nil {
			t.Fatal(err)
		}
		// 1 speech frame + ceil(16000/960) = 17 tail frames; the pump may
		// have taken one already.
		if n := tr.queuedFrames(); n < 17 || n > 18 {
			t.Fatalf("%d frames queued, want 18", n)
		}
		if tr.AudioCommitCount() != 1 {
			t.Fatal("the turn was not counted")
		}
	})

	t.Run("an unknown mode is refused", func(t *testing.T) {
		t.Parallel()
		if _, err := New(Options{AgentID: "a", APIKey: "k", TurnCommitMode: "burst"}); err == nil {
			t.Fatal("accepted an unknown mode")
		}
		if _, err := New(Options{AgentID: "a", APIKey: "k", SilenceTailBytes: -1}); err == nil {
			t.Fatal("accepted a negative tail")
		}
	})
}

func TestHandshakeOverrides(t *testing.T) {
	t.Parallel()
	initFrame := func(t *testing.T, mut func(*Options)) map[string]any {
		t.Helper()
		f := newFake(t)
		o := f.options("agt")
		mut(&o)
		f.connect(o)
		m := f.frames()[0]
		if m["type"] != "conversation_initiation_client_data" {
			t.Fatalf("first frame %v", m)
		}
		return m
	}
	agentOf := func(m map[string]any) map[string]any {
		return m["conversation_config_override"].(map[string]any)["agent"].(map[string]any)
	}

	t.Run("dynamic variables and overrides reach the handshake", func(t *testing.T) {
		t.Parallel()
		m := initFrame(t, func(o *Options) {
			o.DynamicVariables = map[string]any{"tenant_id": "acme", "locale": "en"}
			o.Overrides = map[string]any{"agent": map[string]any{"language": "es"}, "tts": map[string]any{"stability": 0.4}}
		})
		if !reflect.DeepEqual(m["dynamic_variables"], map[string]any{"tenant_id": "acme", "locale": "en"}) {
			t.Fatalf("dynamic_variables %v", m["dynamic_variables"])
		}
		cco := m["conversation_config_override"].(map[string]any)
		if agentOf(m)["language"] != "es" || cco["tts"].(map[string]any)["stability"] != 0.4 {
			t.Fatalf("override %v", cco)
		}
	})

	t.Run("the shared agent key deep-merges", func(t *testing.T) {
		t.Parallel()
		m := initFrame(t, func(o *Options) {
			o.SystemPromptOverride = "X"
			o.Overrides = map[string]any{"agent": map[string]any{"language": "es"}}
		})
		a := agentOf(m)
		if a["prompt"].(map[string]any)["prompt"] != "X" || a["language"] != "es" {
			t.Fatalf("agent %v", a)
		}
	})

	t.Run("the narrow prompt override wins", func(t *testing.T) {
		t.Parallel()
		m := initFrame(t, func(o *Options) {
			o.SystemPromptOverride = "X"
			o.FirstMessageOverride = "Hi"
			o.Overrides = map[string]any{"agent": map[string]any{"prompt": map[string]any{"prompt": "Y"}, "first_message": "Yo"}}
		})
		a := agentOf(m)
		if a["prompt"].(map[string]any)["prompt"] != "X" || a["first_message"] != "Hi" {
			t.Fatalf("agent %v", a)
		}
	})

	t.Run("unset knobs send an empty agent and no dynamic_variables", func(t *testing.T) {
		t.Parallel()
		m := initFrame(t, func(*Options) {})
		if !reflect.DeepEqual(m["conversation_config_override"], map[string]any{"agent": map[string]any{}}) {
			t.Fatalf("override %v", m["conversation_config_override"])
		}
		if _, ok := m["dynamic_variables"]; ok {
			t.Fatal("dynamic_variables sent while unset")
		}
		if len(m) != 2 {
			t.Fatalf("handshake keys %v", m)
		}
	})

	t.Run("a prompt override alone is the pre-change frame", func(t *testing.T) {
		t.Parallel()
		m := initFrame(t, func(o *Options) { o.SystemPromptOverride = "X" })
		want := map[string]any{"agent": map[string]any{"prompt": map[string]any{"prompt": "X"}}}
		if !reflect.DeepEqual(m["conversation_config_override"], want) {
			t.Fatalf("override %v", m["conversation_config_override"])
		}
	})

	t.Run("dynamic variables keep their JSON types", func(t *testing.T) {
		t.Parallel()
		m := initFrame(t, func(o *Options) { o.DynamicVariables = map[string]any{"tier": 2, "vip": true} })
		if !reflect.DeepEqual(m["dynamic_variables"], map[string]any{"tier": float64(2), "vip": true}) {
			t.Fatalf("dynamic_variables %v", m["dynamic_variables"])
		}
	})

	t.Run("the caller's overrides are not modified", func(t *testing.T) {
		t.Parallel()
		ov := map[string]any{"agent": map[string]any{"language": "es"}}
		initFrame(t, func(o *Options) { o.SystemPromptOverride = "X"; o.Overrides = ov })
		if !reflect.DeepEqual(ov, map[string]any{"agent": map[string]any{"language": "es"}}) {
			t.Fatalf("overrides mutated: %v", ov)
		}
	})
}

func TestAdapterContract(t *testing.T) {
	t.Parallel()
	a, err := NewAgent(Options{AgentID: "agt", APIKey: "sk"})
	if err != nil {
		t.Fatal(err)
	}
	b := must(NewAgent(Options{AgentID: "agt", APIKey: "sk",
		DynamicVariables: map[string]any{"tenant": "acme"}, Overrides: map[string]any{"agent": map[string]any{"language": "es"}}}))
	if a.Role() != scenario.AgentRoleAgent || a.Name() != "ElevenLabsAgentAdapter" {
		t.Fatalf("role %v name %q", a.Role(), a.Name())
	}
	if !reflect.DeepEqual(a.Capabilities(), b.Capabilities()) ||
		!reflect.DeepEqual(a.Capabilities().InputFormats, []string{"pcm16/24000"}) ||
		!reflect.DeepEqual(a.Capabilities().OutputFormats, []string{"pcm16/24000"}) {
		t.Fatalf("capabilities %+v", a.Capabilities())
	}
	if a.ResponseTimeout != 60*time.Second {
		t.Fatalf("ResponseTimeout %v, want the 60s Python and JS use", a.ResponseTimeout)
	}
	if a.ConvAI().AgentID() != "agt" || a.VoiceAgent() == nil {
		t.Fatal("agent does not expose its transport")
	}
	if _, err := NewAgent(Options{APIKey: "sk"}); err == nil {
		t.Fatal("accepted a missing AgentID")
	}
}

func TestSecretsStayOutOfLogsAndStrings(t *testing.T) {
	t.Parallel()
	const sentinel = "SENTINEL_9f3"
	f := newFake(t)
	var logs logBuffer
	o := f.options("agt")
	o.APIKey = "sk_" + sentinel
	o.Logger = logs.logger()
	o.DynamicVariables = map[string]any{"tenant": sentinel}
	tr := f.connect(o)
	if strings.Contains(tr.String(), sentinel) || !strings.Contains(tr.String(), "apiKey='***'") {
		t.Fatalf("String() = %q", tr.String())
	}
	f.dropSession()
	waitFor(t, func() bool { return !tr.IsConnected() }, "the drop")
	if strings.Contains(logs.String(), sentinel) {
		t.Fatalf("a secret reached the log: %s", logs.String())
	}
}

// TestRealVoiceInMultiTurn drives a greeting-led two-turn exchange: every
// user turn streams its real PCM, never a user_message text commit, and the
// agent's STT transcript of it comes back.
func TestRealVoiceInMultiTurn(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	f := newFake(t)
	tr := f.connect(f.options("agt_test"))
	speech := func(text string) voice.AudioChunk {
		return voice.AudioChunk{Data: []byte{0x10, 0x00, 0x20, 0x00, 0x30, 0x00, 0x40, 0x00}, Transcript: text}
	}
	agentSpeaks := func() {
		t.Helper()
		f.emit(audioEvent([]byte{0x01, 0x00, 0x02, 0x00}))
		if _, err := tr.ReceiveAudio(ctx, time.Second); err != nil {
			t.Fatal(err)
		}
	}
	realSpeechFrom := func(from int) bool {
		frames := f.frames()
		for _, b := range audioFrames(frames[min(from, len(frames)):]) {
			if !isSilent(b) {
				return true
			}
		}
		return false
	}

	agentSpeaks() // greeting
	if err := tr.SendAudio(ctx, speech("Hi, I have a question about my account balance.")); err != nil {
		t.Fatal(err)
	}
	f.waitFor(func() bool { return realSpeechFrom(0) }, "turn 1 speech")
	agentSpeaks()

	turn2 := len(f.frames())
	if err := tr.SendAudio(ctx, speech("Thanks. What are your support hours this week?")); err != nil {
		t.Fatal(err)
	}
	f.waitFor(func() bool { return realSpeechFrom(turn2) }, "turn 2 speech")
	f.emit(map[string]any{"type": "user_transcript", "user_transcription_event": map[string]any{
		"user_transcript": "thanks what are your support hours this week"}})
	f.sync()

	if n := len(framesOfType(f.frames(), "user_message")); n != 0 {
		t.Fatalf("%d user_message text commits", n)
	}
	if tr.AudioCommitCount() < 2 || tr.LastUserTranscript() == "" {
		t.Fatalf("commits %d, user transcript %q", tr.AudioCommitCount(), tr.LastUserTranscript())
	}
}
