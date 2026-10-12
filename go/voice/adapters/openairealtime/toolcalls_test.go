package openairealtime

import (
	"slices"
	"strings"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/internal/realtimetest"
)

// Realtime function calls surface as tool messages state.HasToolCall and
// LastToolCall recognise, whichever wire form carries them.

func streamingCall(callID, name, args string) []map[string]any {
	mid := len(args) / 2
	return []map[string]any{
		{"type": "response.output_item.added", "item": map[string]any{"type": "function_call", "name": name, "call_id": callID}},
		{"type": "response.function_call_arguments.delta", "call_id": callID, "delta": args[:mid]},
		{"type": "response.function_call_arguments.delta", "call_id": callID, "delta": args[mid:]},
		{"type": "response.function_call_arguments.done", "call_id": callID, "arguments": args},
	}
}

func outputItemCall(callID, name, args string) []map[string]any {
	return []map[string]any{{"type": "response.output_item.done",
		"item": map[string]any{"type": "function_call", "name": name, "call_id": callID, "arguments": args}}}
}

func responseDone() []map[string]any                 { return []map[string]any{{"type": "response.done"}} }
func audioDelta() []map[string]any                   { return []map[string]any{pcmDelta()} }
func seq(parts ...[]map[string]any) []map[string]any { return slices.Concat(parts...) }

// feedAndCall runs one agent turn on a connected adapter, feeding events
// once its response.create landed.
func feedAndCall(t *testing.T, srv *realtimetest.Server, a *Adapter, events []map[string]any) callResult {
	t.Helper()
	mark := srv.Len()
	ch := startCall(a, audioInput(voice.AudioChunk{Data: []byte{0, 0, 0, 0}}))
	srv.WaitType(t, "response.create", mark)
	for _, e := range events {
		srv.Push(t, e)
	}
	return await(t, ch)
}

func runToolTurn(t *testing.T, events []map[string]any, responseTimeout time.Duration) []scenario.Message {
	t.Helper()
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{Role: scenario.AgentRoleAgent})
	a.ResponseTimeout = responseTimeout
	connect(t, srv, a)
	r := feedAndCall(t, srv, a, events)
	if r.err != nil {
		t.Fatal(r.err)
	}
	return r.msgs
}

func toolMsgs(msgs []scenario.Message) []scenario.Message {
	var out []scenario.Message
	for _, m := range msgs {
		if m.Role == scenario.RoleTool {
			out = append(out, m)
		}
	}
	return out
}

func toolNames(msgs []scenario.Message) []string {
	var out []string
	for _, m := range toolMsgs(msgs) {
		out = append(out, m.ToolName)
	}
	slices.Sort(out)
	return out
}

func toolMsg(t *testing.T, msgs []scenario.Message, name string) scenario.Message {
	t.Helper()
	for _, m := range toolMsgs(msgs) {
		if m.ToolName == name {
			return m
		}
	}
	t.Fatalf("no tool message for %s in %+v", name, msgs)
	return scenario.Message{}
}

func TestToolCallSurfacesAsAToolMessage(t *testing.T) {
	msgs := runToolTurn(t, seq(audioDelta(), streamingCall("call_a", "get_weather", `{"city":"Paris"}`)), 2*time.Second)
	m := toolMsg(t, msgs, "get_weather")
	if m.ToolCallID != "call_a" || m.Content != `{"city":"Paris"}` {
		t.Fatalf("tool message = %+v", m)
	}
	st := stateWith(t, msgs)
	if !st.HasToolCall("get_weather") {
		t.Fatal("HasToolCall false")
	}
	last, err := st.LastToolCall("get_weather")
	if err != nil || last.Role != scenario.RoleTool || last.ToolCallID != "call_a" {
		t.Fatalf("last = %+v, %v", last, err)
	}
}

// A tool-only turn (no audio) ends at response.done instead of timing out,
// in either wire form.
func TestToolOnlyTurnEndsAtResponseDone(t *testing.T) {
	for name, events := range map[string][]map[string]any{
		"streaming":   seq(streamingCall("call_weather", "get_weather", `{"city":"Paris"}`), responseDone()),
		"output item": seq(outputItemCall("call_ac4o", "get_weather", `{"id":99}`), responseDone()),
	} {
		t.Run(name, func(t *testing.T) {
			msgs := runToolTurn(t, events, 500*time.Millisecond)
			if !stateWith(t, msgs).HasToolCall("get_weather") {
				t.Fatalf("messages = %+v", msgs)
			}
		})
	}
}

func TestTwoCallsOnAToolOnlyTurnBothSurface(t *testing.T) {
	msgs := runToolTurn(t, seq(streamingCall("call_1", "get_weather", `{"city":"NYC"}`),
		outputItemCall("call_2", "get_time", `{"tz":"UTC"}`), responseDone()), 500*time.Millisecond)
	if got := toolNames(msgs); !slices.Equal(got, []string{"get_time", "get_weather"}) {
		t.Fatalf("names = %v", got)
	}
	st := stateWith(t, msgs)
	if !st.HasToolCall("get_weather") || !st.HasToolCall("get_time") {
		t.Fatal("not both visible")
	}
}

func TestAudioAndToolTurnReturnsBothMessages(t *testing.T) {
	msgs := runToolTurn(t, seq(audioDelta(), streamingCall("call_co", "fetch", `{"k":"v"}`), responseDone()), 2*time.Second)
	if len(msgs) != 2 || msgs[0].Role != scenario.RoleAssistant || msgs[1].Role != scenario.RoleTool {
		t.Fatalf("messages = %+v", msgs)
	}
}

func TestToolOnlyThenAudioOnlyTurnDoesNotBleed(t *testing.T) {
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{})
	a.ResponseTimeout = 500 * time.Millisecond
	connect(t, srv, a)
	t1 := feedAndCall(t, srv, a, seq(outputItemCall("call_t1", "get_weather", "{}"), responseDone()))
	if t1.err != nil || len(toolMsgs(t1.msgs)) != 1 {
		t.Fatalf("turn 1 = %+v", t1)
	}
	a.ResponseTimeout = 2 * time.Second
	t2 := feedAndCall(t, srv, a, audioDelta())
	if t2.err != nil || len(t2.msgs) != 1 || len(toolMsgs(t2.msgs)) != 0 {
		t.Fatalf("turn 2 = %+v", t2)
	}
}

// An empty turn (no audio, no call) still times out: the non-empty
// accumulator, not response.done alone, ends a silent turn.
func TestEmptyTurnStillTimesOut(t *testing.T) {
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{})
	a.ResponseTimeout = 500 * time.Millisecond
	connect(t, srv, a)
	r := feedAndCall(t, srv, a, responseDone())
	if r.err == nil || !strings.Contains(r.err.Error(), "receiveAudio timed out") {
		t.Fatalf("err = %v", r.err)
	}
}

// Malformed arguments are carried verbatim, serialized as a text output.
func TestMalformedArgumentsDegrade(t *testing.T) {
	for name, events := range map[string][]map[string]any{
		"tool-only": seq(outputItemCall("call_bad", "noop", "{not json"), responseDone()),
		"audio":     seq(audioDelta(), outputItemCall("call_bad", "noop", "{not json")),
	} {
		t.Run(name, func(t *testing.T) {
			msgs := runToolTurn(t, events, time.Second)
			if m := toolMsg(t, msgs, "noop"); m.Content != "{not json" {
				t.Fatalf("content = %q", m.Content)
			}
			st := stateWith(t, msgs)
			if !st.HasToolCall("noop") {
				t.Fatal("not visible")
			}
		})
	}
}

func TestCallOnlyViaOutputItemDoneSurfaces(t *testing.T) {
	msgs := runToolTurn(t, seq(audioDelta(), outputItemCall("call_b", "lookup_order", `{"id":42}`)), 2*time.Second)
	if m := toolMsg(t, msgs, "lookup_order"); m.ToolCallID != "call_b" {
		t.Fatalf("id = %s", m.ToolCallID)
	}
}

// Both forms describing one call_id yield exactly one call.
func TestSameCallInBothFormsIsDeduplicated(t *testing.T) {
	msgs := runToolTurn(t, seq(audioDelta(), streamingCall("call_dup", "get_weather", `{"city":"Berlin"}`),
		outputItemCall("call_dup", "get_weather", `{"city":"Berlin"}`)), 2*time.Second)
	if n := len(toolMsgs(msgs)); n != 1 {
		t.Fatalf("tool messages = %d", n)
	}
}

func TestMissingArgumentsDefaultAndMissingCallIDIsSkipped(t *testing.T) {
	msgs := runToolTurn(t, seq(audioDelta(),
		[]map[string]any{{"type": "response.function_call_arguments.done", "arguments": `{"x":1}`}},
		[]map[string]any{{"type": "response.output_item.done", "item": map[string]any{"type": "function_call", "name": "ping", "call_id": "call_noargs"}}},
	), 2*time.Second)
	if m := toolMsg(t, msgs, "ping"); m.Content != "{}" {
		t.Fatalf("content = %q", m.Content)
	}
	if got := toolNames(msgs); !slices.Equal(got, []string{"ping"}) {
		t.Fatalf("names = %v", got)
	}
}

func TestAudioOnlyTurnHasNoToolMessage(t *testing.T) {
	msgs := runToolTurn(t, audioDelta(), 2*time.Second)
	if len(msgs) != 1 || msgs[0].Role != scenario.RoleAssistant {
		t.Fatalf("messages = %+v", msgs)
	}
	if stateWith(t, msgs).HasToolCall("anything") {
		t.Fatal("phantom tool call")
	}
}

func TestTwoDistinctCallsInOneTurn(t *testing.T) {
	msgs := runToolTurn(t, seq(audioDelta(), streamingCall("call_1", "get_weather", `{"city":"Paris"}`),
		outputItemCall("call_2", "lookup_order", `{"id":7}`)), 2*time.Second)
	if got := toolNames(msgs); !slices.Equal(got, []string{"get_weather", "lookup_order"}) {
		t.Fatalf("names = %v", got)
	}
}

func TestToolCallsResetPerTurn(t *testing.T) {
	srv := realtimetest.New(t)
	a := buildAdapter(srv, Options{})
	connect(t, srv, a)
	t1 := feedAndCall(t, srv, a, seq(audioDelta(), outputItemCall("call_t1", "get_weather", "{}")))
	if !stateWith(t, t1.msgs).HasToolCall("get_weather") {
		t.Fatal("turn 1 call missing")
	}
	t2 := feedAndCall(t, srv, a, seq(audioDelta(), outputItemCall("call_t2", "lookup_order", "{}")))
	if got := toolNames(t2.msgs); !slices.Equal(got, []string{"lookup_order"}) {
		t.Fatalf("turn 2 names = %v", got)
	}
}

// The accumulator merges a later, more complete arguments string.
func TestFinalizeMergesOnCallID(t *testing.T) {
	var tc toolCalls
	tc.noteName("c", "n")
	tc.addDelta("c", `{"a"`)
	if !tc.finalize("c", "", "") {
		t.Fatal("finalize failed")
	}
	tc.finalize("c", "", `{"a":1}`)
	tc.finalize("c", "other", "{}")
	if len(tc.completed) != 1 || tc.completed[0] != (ToolCall{ID: "c", Name: "n", Arguments: `{"a":1}`}) {
		t.Fatalf("completed = %+v", tc.completed)
	}
	if tc.finalize("", "x", "{}") {
		t.Fatal("finalized without call id")
	}
}
