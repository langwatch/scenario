package openairealtime

import (
	"bytes"
	"context"
	"encoding/base64"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/internal/realtimetest"
)

const customerPersona = "You are a customer calling your bank's support line."

func connectUser(t *testing.T, instructions string) (*realtimetest.Server, *Adapter) {
	t.Helper()
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{Voice: "marin", Instructions: instructions, Role: scenario.AgentRoleUser,
		UserTurnTailTimeout: time.Second})
	connect(t, srv, a)
	return srv, a
}

func speak(a *Adapter, text string) <-chan voice.AudioChunk {
	ch := make(chan voice.AudioChunk, 1)
	go func() {
		c, _ := a.SpeakUserTurn(context.Background(), text)
		ch <- c
	}()
	return ch
}

func responseOf(f realtimetest.Frame) map[string]any {
	r, _ := f.Data["response"].(map[string]any)
	return r
}

// The scripted line is spoken, not answered: one isolated response.create
// carrying the persona and the line, no user item; the spoken deltas merge
// into one chunk labelled with the model's own transcript.
func TestSpeakUserTurnSpeaksTheLineAndMergesTheAudio(t *testing.T) {
	srv, a := connectUser(t, "simulate a customer")
	ch := speak(a, "hi, a question about my account")
	srv.WaitType(t, "response.create", 0)
	resp := responseOf(srv.OfType("response.create")[0])
	instr, _ := resp["instructions"].(string)
	if !strings.Contains(instr, "hi, a question about my account") || !strings.HasPrefix(instr, "simulate a customer\n\n") {
		t.Fatalf("instructions = %q", instr)
	}
	if resp["conversation"] != "none" || !reflect.DeepEqual(resp["input"], []any{}) ||
		!reflect.DeepEqual(resp["output_modalities"], []any{"audio"}) {
		t.Fatalf("response = %v", resp)
	}
	if slices.Contains(srv.Types(), "conversation.item.create") {
		t.Fatal("sent a user item")
	}
	srv.Push(t, map[string]any{"type": "response.output_audio_transcript.done", "transcript": "Hi, I have a question about my account."})
	srv.Push(t, map[string]any{"type": "response.output_audio.delta", "delta": b64(1, 0, 2, 0)})
	srv.Push(t, map[string]any{"type": "response.output_audio.delta", "delta": b64(3, 0, 4, 0)})
	c := <-ch
	if !bytes.Equal(c.Data, []byte{1, 0, 2, 0, 3, 0, 4, 0}) || c.Transcript != "Hi, I have a question about my account." {
		t.Fatalf("chunk = %v %q", c.Data, c.Transcript)
	}
}

func TestSpeakUserTurnFallsBackToTheScriptedText(t *testing.T) {
	srv, a := connectUser(t, "simulate a customer")
	ch := speak(a, "reset my password please")
	srv.WaitType(t, "response.create", 0)
	srv.Push(t, map[string]any{"type": "response.output_audio.delta", "delta": b64(5, 0)})
	c := <-ch
	if !bytes.Equal(c.Data, []byte{5, 0}) || c.Transcript != "reset my password please" {
		t.Fatalf("chunk = %v %q", c.Data, c.Transcript)
	}
}

// emptyDelta ends a spoken turn at once: it decodes to a zero-length chunk.
func emptyDelta() map[string]any {
	return map[string]any{"type": "response.output_audio.delta", "delta": ""}
}

func hearing(heard []byte) scenario.AgentInput {
	if heard == nil {
		return scenario.AgentInput{}
	}
	return scenario.AgentInput{NewMessages: []scenario.Message{voice.AudioMessage(voice.AudioChunk{Data: heard}, scenario.RoleAssistant)}}
}

func userAudio(t *testing.T, r callResult) voice.AudioChunk {
	t.Helper()
	if r.err != nil {
		t.Fatal(r.err)
	}
	if len(r.msgs) != 1 || r.msgs[0].Role != scenario.RoleUser {
		t.Fatalf("messages = %+v", r.msgs)
	}
	c, ok := voice.ExtractAudio(r.msgs[0])
	if !ok {
		t.Fatal("no audio")
	}
	return c
}

func appended(f realtimetest.Frame) []byte {
	b, _ := base64.StdEncoding.DecodeString(f.Data["audio"].(string))
	return b
}

// The autonomous user turn: one generative, in-context response.create (no
// verbatim isolation, no user item) returning one user audio turn.
func TestAutonomousUserTurnGeneratesTheNextLine(t *testing.T) {
	srv, a := connectUser(t, customerPersona)
	ch := startCall(a, hearing([]byte{0xaa, 0xaa, 0xbb, 0xbb}))
	srv.WaitType(t, "response.create", 0)
	settle()
	creates := srv.OfType("response.create")
	if len(creates) != 1 {
		t.Fatalf("response.create = %d", len(creates))
	}
	resp := responseOf(creates[0])
	instr, _ := resp["instructions"].(string)
	lower := strings.ToLower(instr)
	if !strings.Contains(lower, "you are the customer") || !strings.Contains(lower, "next line") || !strings.Contains(instr, customerPersona) {
		t.Fatalf("instructions = %q", instr)
	}
	if !reflect.DeepEqual(resp["output_modalities"], []any{"audio"}) {
		t.Fatalf("modalities = %v", resp["output_modalities"])
	}
	if _, ok := resp["conversation"]; ok {
		t.Fatal("generative turn is isolated (conversation)")
	}
	if _, ok := resp["input"]; ok {
		t.Fatal("generative turn is isolated (input)")
	}
	if slices.Contains(srv.Types(), "conversation.item.create") {
		t.Fatal("sent a user item")
	}
	srv.Push(t, map[string]any{"type": "response.output_audio_transcript.done", "transcript": "Hi, I want to check my balance."})
	srv.Push(t, map[string]any{"type": "response.output_audio.delta", "delta": b64(1, 0)})
	srv.Push(t, map[string]any{"type": "response.output_audio.delta", "delta": b64(2, 0)})
	srv.Push(t, emptyDelta())
	c := userAudio(t, await(t, ch))
	if !bytes.Equal(c.Data, []byte{1, 0, 2, 0}) || c.Transcript != "Hi, I want to check my balance." {
		t.Fatalf("chunk = %v %q", c.Data, c.Transcript)
	}
}

func TestAutonomousUserTurnAppendsTheHeardAudioFirst(t *testing.T) {
	srv, a := connectUser(t, customerPersona)
	heard := []byte{0x10, 0x11, 0x12, 0x13, 0x14, 0x15}
	ch := startCall(a, hearing(heard))
	srv.WaitType(t, "response.create", 0)
	appends := srv.OfType("input_audio_buffer.append")
	if len(appends) != 1 || !bytes.Equal(appended(appends[0]), heard) {
		t.Fatalf("appends = %v", appends)
	}
	types := srv.Types()
	ai, ci, ri := slices.Index(types, "input_audio_buffer.append"), slices.Index(types, "input_audio_buffer.commit"), slices.Index(types, "response.create")
	if !(ai < ci && ci < ri) || ai < 0 {
		t.Fatalf("order = %v", types)
	}
	srv.Push(t, map[string]any{"type": "response.output_audio.delta", "delta": b64(7, 0)})
	srv.Push(t, emptyDelta())
	userAudio(t, await(t, ch))
}

func TestAutonomousUserTurnWithoutHeardAudio(t *testing.T) {
	srv, a := connectUser(t, customerPersona)
	ch := startCall(a, hearing(nil))
	srv.WaitType(t, "response.create", 0)
	settle()
	types := srv.Types()
	if slices.Contains(types, "input_audio_buffer.append") || slices.Contains(types, "input_audio_buffer.commit") || len(srv.OfType("response.create")) != 1 {
		t.Fatalf("frames = %v", types)
	}
	srv.Push(t, map[string]any{"type": "response.output_audio_transcript.done", "transcript": "Hello there."})
	srv.Push(t, map[string]any{"type": "response.output_audio.delta", "delta": b64(9, 0)})
	srv.Push(t, emptyDelta())
	if c := userAudio(t, await(t, ch)); len(c.Data) == 0 {
		t.Fatal("no audio")
	}
}

// Audio presence, not transcript presence, is the contract.
func TestAutonomousUserTurnWithoutTranscript(t *testing.T) {
	srv, a := connectUser(t, customerPersona)
	ch := startCall(a, hearing([]byte{1, 2}))
	srv.WaitType(t, "response.create", 0)
	srv.Push(t, map[string]any{"type": "response.output_audio.delta", "delta": b64(0x21, 0)})
	srv.Push(t, emptyDelta())
	if c := userAudio(t, await(t, ch)); len(c.Data) == 0 || c.Transcript != "" {
		t.Fatalf("chunk = %v %q", c.Data, c.Transcript)
	}
}

func TestAgentRoleNeverTakesTheAutonomousUserPath(t *testing.T) {
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{Role: scenario.AgentRoleAgent})
	if _, err := a.Call(context.Background(), scenario.AgentInput{}); err == nil {
		t.Fatal("unconnected agent call succeeded")
	}
}

// Two consecutive autonomous turns: each one response.create, the second
// appending its own heard bytes and carrying its own transcript.
func TestAutonomousUserTurnsDoNotBleed(t *testing.T) {
	srv, a := connectUser(t, customerPersona)
	heard1, heard2 := []byte{0xaa, 0xaa, 0xbb, 0xbb}, []byte{0xcc, 0xcc, 0xdd, 0xdd}

	ch := startCall(a, hearing(heard1))
	srv.WaitType(t, "response.create", 0)
	srv.Push(t, map[string]any{"type": "response.output_audio_transcript.done", "transcript": "turn one customer line"})
	srv.Push(t, map[string]any{"type": "response.output_audio.delta", "delta": b64(1, 0)})
	srv.Push(t, emptyDelta())
	if c := userAudio(t, await(t, ch)); c.Transcript != "turn one customer line" {
		t.Fatalf("turn 1 transcript = %q", c.Transcript)
	}

	mark := srv.Len()
	ch = startCall(a, hearing(heard2))
	srv.WaitType(t, "response.create", mark)
	settle()
	turn2 := srv.Frames()[mark:]
	var creates, appends []realtimetest.Frame
	for _, f := range turn2 {
		switch f.Type {
		case "response.create":
			creates = append(creates, f)
		case "input_audio_buffer.append":
			appends = append(appends, f)
		}
	}
	if len(creates) != 1 || len(appends) != 1 || !bytes.Equal(appended(appends[0]), heard2) {
		t.Fatalf("turn 2 frames = %v", turn2)
	}
	srv.Push(t, map[string]any{"type": "response.output_audio_transcript.done", "transcript": "turn two customer line"})
	srv.Push(t, map[string]any{"type": "response.output_audio.delta", "delta": b64(3, 0)})
	srv.Push(t, emptyDelta())
	if c := userAudio(t, await(t, ch)); c.Transcript != "turn two customer line" {
		t.Fatalf("turn 2 transcript = %q", c.Transcript)
	}
}

func TestSecondAutonomousTurnWithoutTranscriptDoesNotInheritTheFirst(t *testing.T) {
	srv, a := connectUser(t, customerPersona)
	ch := startCall(a, hearing([]byte{1, 2}))
	srv.WaitType(t, "response.create", 0)
	srv.Push(t, map[string]any{"type": "response.output_audio_transcript.done", "transcript": "turn one customer line"})
	srv.Push(t, map[string]any{"type": "response.output_audio.delta", "delta": b64(1, 0)})
	srv.Push(t, emptyDelta())
	userAudio(t, await(t, ch))

	mark := srv.Len()
	ch = startCall(a, hearing([]byte{3, 4}))
	srv.WaitType(t, "response.create", mark)
	srv.Push(t, map[string]any{"type": "response.output_audio.delta", "delta": b64(5, 0)})
	srv.Push(t, emptyDelta())
	if c := userAudio(t, await(t, ch)); c.Transcript != "" {
		t.Fatalf("turn 2 inherited %q", c.Transcript)
	}
}

// End to end: the realtime user speaks a scripted line into a voice agent
// under test through scenario.Run, with no TTS.
func TestRealtimeUserSpeaksScriptedLinesInARun(t *testing.T) {
	srv, user := connectUserForRun(t)
	heard := make(chan []byte, 1)
	agent := scenario.AgentFunc(func(_ context.Context, in scenario.AgentInput) (*scenario.AgentReturn, error) {
		if c, ok := voice.ExtractAudio(in.NewMessages[len(in.NewMessages)-1]); ok {
			heard <- c.Data
		}
		return scenario.TextReturn("ok"), nil
	})
	go func() {
		srv.WaitConnected(t)
		srv.WaitType(t, "response.create", 0)
		srv.Push(t, map[string]any{"type": "response.output_audio.delta", "delta": b64(8, 0, 9, 0)})
		srv.Push(t, emptyDelta())
	}()
	res, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name: "realtime user", Description: "realtime user",
		Agents: []scenario.AgentAdapter{agent, user},
		Script: []scenario.ScriptStep{scenario.User("hello there"), scenario.Agent(), scenario.Succeed()},
	}, voice.WithConfig(voice.Config{Logger: quiet}), scenario.WithQuiet())
	if err != nil || !res.Success {
		t.Fatalf("run: %v %+v", err, res)
	}
	if got := <-heard; !bytes.Equal(got, []byte{8, 0, 9, 0}) {
		t.Fatalf("agent heard %v", got)
	}
}

func connectUserForRun(t *testing.T) (*realtimetest.Server, *Adapter) {
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{Role: scenario.AgentRoleUser, Instructions: customerPersona, UserTurnTailTimeout: time.Second})
	srv.Arm()
	return srv, a
}
