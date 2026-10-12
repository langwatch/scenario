package openairealtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/internal/realtimetest"
)

// The model connects as the agent under test: the GA session.update, the
// audio loop (append, commit + response.create, decoded deltas, the
// transcript) and response.cancel as the interrupt.
func TestConnectsAsTheAgentUnderTest(t *testing.T) {
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{
		Model:        DefaultModel,
		Voice:        "alloy",
		Instructions: "You are a helpful assistant.",
		Tools:        []Tool{{Name: "noop"}},
		APIKey:       "test-key",
		Role:         scenario.AgentRoleAgent,
	})
	caps := a.Capabilities()
	want := voice.Capabilities{StreamingTranscripts: true, NativeVAD: true, Interruption: true,
		InputFormats: []string{"pcm16/24000"}, OutputFormats: []string{"pcm16/24000"}}
	if !reflect.DeepEqual(caps, want) {
		t.Fatalf("capabilities = %+v", caps)
	}
	if a.Role() != scenario.AgentRoleAgent || a.Name() != "OpenAIRealtimeAgentAdapter" {
		t.Fatalf("role %s name %s", a.Role(), a.Name())
	}
	for _, s := range []string{a.String(), fmt.Sprintf("%v", a), fmt.Sprintf("%#v", a), fmt.Sprintf("%v", a.Realtime())} {
		if !strings.Contains(s, "api_key='***'") || strings.Contains(s, "test-key") {
			t.Fatalf("string form leaks or lacks the key mask: %s", s)
		}
	}

	connect(t, srv, a)
	if got := srv.Paths()[0]; got != "/realtime?model="+DefaultModel {
		t.Fatalf("path = %s", got)
	}
	if got := srv.Headers()[0].Get("Authorization"); got != "Bearer test-key" {
		t.Fatalf("auth = %s", got)
	}
	if srv.Headers()[0].Get("OpenAI-Beta") != "" {
		t.Fatal("sent the Beta opt-in header")
	}
	update := srv.OfType("session.update")[0]
	var got struct {
		Session struct {
			Type         string `json:"type"`
			Model        string `json:"model"`
			Instructions string `json:"instructions"`
			Tools        []map[string]any
			Audio        struct {
				Input struct {
					Format        map[string]any  `json:"format"`
					Transcription map[string]any  `json:"transcription"`
					TurnDetection json.RawMessage `json:"turn_detection"`
				} `json:"input"`
				Output struct {
					Format map[string]any `json:"format"`
					Voice  string         `json:"voice"`
				} `json:"output"`
			} `json:"audio"`
		} `json:"session"`
	}
	if err := json.Unmarshal(update.Raw, &got); err != nil {
		t.Fatal(err)
	}
	s := got.Session
	pcm := map[string]any{"type": "audio/pcm", "rate": 24000.0}
	if s.Type != "realtime" || s.Model != DefaultModel || s.Instructions != "You are a helpful assistant." ||
		!reflect.DeepEqual(s.Audio.Input.Format, pcm) || !reflect.DeepEqual(s.Audio.Output.Format, pcm) ||
		s.Audio.Output.Voice != "alloy" || string(s.Audio.Input.TurnDetection) != "null" ||
		s.Audio.Input.Transcription["model"] != TranscriptionModel {
		t.Fatalf("session = %s", update.Raw)
	}
	if !reflect.DeepEqual(s.Tools, []map[string]any{{"type": "function", "name": "noop"}}) {
		t.Fatalf("tools = %v", s.Tools)
	}

	ctx := context.Background()
	rt := a.Realtime()
	silence := voice.SilentChunk(0.02)
	if err := rt.SendAudio(ctx, silence); err != nil {
		t.Fatal(err)
	}
	srv.WaitType(t, "input_audio_buffer.append", 0)
	if f := srv.OfType("input_audio_buffer.append")[0]; f.Data["audio"] != b64(silence.Data...) {
		t.Fatal("append payload is not the base64 PCM")
	}

	type recv struct {
		c   voice.AudioChunk
		err error
	}
	ch := make(chan recv, 1)
	go func() {
		c, err := rt.ReceiveAudio(ctx, 2*time.Second)
		ch <- recv{c, err}
	}()
	srv.WaitType(t, "input_audio_buffer.commit", 0)
	srv.WaitType(t, "response.create", 0)
	srv.Push(t, map[string]any{"type": "response.audio_transcript.delta", "delta": "hello "})
	srv.Push(t, map[string]any{"type": "response.audio_transcript.delta", "delta": "world"})
	srv.Push(t, map[string]any{"type": "response.audio_transcript.done", "transcript": "hello world"})
	srv.Push(t, map[string]any{"type": "response.audio.delta", "delta": b64(0x10, 0x00, 0x20, 0x00)})
	r := <-ch
	if r.err != nil || !bytes.Equal(r.c.Data, []byte{0x10, 0x00, 0x20, 0x00}) {
		t.Fatalf("chunk = %v, %v", r.c.Data, r.err)
	}
	if rt.LastAgentTranscript() != "hello world" {
		t.Fatalf("transcript = %q", rt.LastAgentTranscript())
	}

	if err := rt.Interrupt(ctx); err != nil {
		t.Fatal(err)
	}
	srv.WaitType(t, "response.cancel", 0)
	if err := rt.Disconnect(ctx); err != nil {
		t.Fatal(err)
	}
	if rt.IsConnected() {
		t.Fatal("still connected")
	}
}

// With the user role the model drives the user side: scripted text goes in
// as an input_text user item followed by response.create, and no TTS audio
// is appended.
func TestUserRoleActsAsTheUserSimulator(t *testing.T) {
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{Voice: "nova", Instructions: "simulate a confused elderly customer", Role: scenario.AgentRoleUser})
	if a.Role() != scenario.AgentRoleUser {
		t.Fatalf("role = %s", a.Role())
	}
	connect(t, srv, a)
	const line = "i'm trying to reset my password"
	if err := a.Realtime().SendText(context.Background(), line); err != nil {
		t.Fatal(err)
	}
	srv.WaitType(t, "conversation.item.create", 0)
	srv.WaitType(t, "response.create", 0)
	item := srv.OfType("conversation.item.create")[0].Data["item"]
	want := map[string]any{"type": "message", "role": "user",
		"content": []any{map[string]any{"type": "input_text", "text": line}}}
	if !reflect.DeepEqual(item, want) {
		t.Fatalf("item = %v", item)
	}
	types := srv.Types()
	if i := slices.Index(types, "conversation.item.create"); slices.Index(types[i+1:], "response.create") < 0 {
		t.Fatalf("no response.create after the item: %v", types)
	}
	if slices.Contains(types, "input_audio_buffer.append") {
		t.Fatal("TTS audio was appended for the scripted line")
	}
}

// Before Connect a real leaf reports itself disconnected and a turn fails
// with a PendingTransportError (the connected-state gate).
func TestTurnBeforeConnectIsAPendingTransportError(t *testing.T) {
	a := New(Options{Model: "gpt-realtime-mini", APIKey: "sk-test", NoMint: true})
	if a.Realtime().IsConnected() {
		t.Fatal("connected before Connect")
	}
	_, err := a.Call(context.Background(), scenario.AgentInput{})
	var pending *voice.PendingTransportError
	if !errors.As(err, &pending) || pending.Adapter != "OpenAIRealtimeAgentAdapter" {
		t.Fatalf("err = %v", err)
	}
}

func TestURLResolution(t *testing.T) {
	if got := New(Options{NoMint: true}).Realtime().URL(); got != "wss://api.openai.com/v1/realtime?model=gpt-realtime-mini" {
		t.Fatalf("default = %s", got)
	}
	t.Setenv("OPENAI_REALTIME_URL", "wss://proxy.example/rt?m={model}")
	if got := New(Options{NoMint: true, Model: "m1"}).Realtime().URL(); got != "wss://proxy.example/rt?m=m1" {
		t.Fatalf("env = %s", got)
	}
	if got := New(Options{NoMint: true, URL: "ws://x/rt"}).Realtime().URL(); got != "ws://x/rt" {
		t.Fatalf("override = %s", got)
	}
}

func TestOperationsBeforeConnectFail(t *testing.T) {
	rt := New(Options{NoMint: true}).Realtime()
	ctx := context.Background()
	for name, err := range map[string]error{
		"send":      rt.SendAudio(ctx, voice.SilentChunk(0.01)),
		"interrupt": rt.Interrupt(ctx),
		"sendText":  rt.SendText(ctx, "x"),
	} {
		if err == nil || !strings.Contains(err.Error(), "not connected") {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	if _, err := rt.ReceiveAudio(ctx, time.Millisecond); err == nil {
		t.Error("receive before connect succeeded")
	}
	if err := rt.Disconnect(ctx); err != nil {
		t.Errorf("disconnect before connect: %v", err)
	}
}

// A socket the server closes fails the in-flight receive promptly.
func TestServerCloseFailsTheReceive(t *testing.T) {
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{})
	connect(t, srv, a)
	errc := make(chan error, 1)
	go func() {
		_, err := a.Realtime().ReceiveAudio(context.Background(), 5*time.Second)
		errc <- err
	}()
	time.Sleep(20 * time.Millisecond)
	srv.Close()
	select {
	case err := <-errc:
		if err == nil || !strings.Contains(err.Error(), "socket closed") {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("receive did not fail on close")
	}
}

// Non-JSON frames are dropped, and an odd-byte delta is surfaced as an
// error rather than truncated.
func TestNonJSONDroppedAndOddDeltaFails(t *testing.T) {
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{})
	connect(t, srv, a)
	srv.PushRaw(t, []byte("not json"))
	srv.Push(t, map[string]any{"type": "response.output_audio.delta", "delta": b64(1, 2, 3)})
	_, err := a.Realtime().ReceiveAudio(context.Background(), 2*time.Second)
	if err == nil || !strings.Contains(err.Error(), "not a multiple") {
		t.Fatalf("err = %v", err)
	}
}
