package openairealtime

import (
	scenario "github.com/langwatch/scenario/go"
)

// The Realtime wire describes one logical function call across several
// events (response.function_call_arguments.delta × N then .done, and/or
// response.output_item.added / .done carrying the function_call item). The
// receive loop accumulates them per call_id and finalizes each call once,
// de-duplicated on call_id; the adapter's Call appends the turn's calls to
// its messages.

// ToolCall is a function call the model made during a turn.
type ToolCall struct {
	// ID is the Realtime call_id.
	ID string
	// Name is the function name, empty when the wire never carried one.
	Name string
	// Arguments is the raw JSON arguments string: "{}" when absent,
	// verbatim when malformed.
	Arguments string
}

// toolCallAccumulator is one call being assembled from the wire.
type toolCallAccumulator struct {
	name string
	args string
}

// toolCalls is the per-turn tool-call state. It is guarded by the
// transport's mutex.
type toolCalls struct {
	acc       map[string]*toolCallAccumulator
	completed []ToolCall
}

func (tc *toolCalls) reset() {
	tc.acc = nil
	tc.completed = nil
}

func (tc *toolCalls) accumulator(callID string) *toolCallAccumulator {
	if tc.acc == nil {
		tc.acc = map[string]*toolCallAccumulator{}
	}
	a := tc.acc[callID]
	if a == nil {
		a = &toolCallAccumulator{}
		tc.acc[callID] = a
	}
	return a
}

// addDelta appends a streaming arguments fragment.
func (tc *toolCalls) addDelta(callID, delta string) {
	a := tc.accumulator(callID)
	a.args += delta
}

// noteName records the function name from the output-item shell.
func (tc *toolCalls) noteName(callID, name string) {
	if name == "" {
		return
	}
	tc.accumulator(callID).name = name
}

// finalize resolves one call. It is idempotent on callID: a second finalize
// merges (fills a missing name, upgrades to a longer arguments string)
// rather than appending a duplicate. A call without callID is skipped
// (reported false), never an error.
func (tc *toolCalls) finalize(callID, name, args string) bool {
	if callID == "" {
		return false
	}
	a := tc.acc[callID]
	if name == "" && a != nil {
		name = a.name
	}
	if args == "" && a != nil {
		args = a.args
	}
	if args == "" {
		args = "{}"
	}
	for i := range tc.completed {
		existing := &tc.completed[i]
		if existing.ID != callID {
			continue
		}
		if existing.Name == "" && name != "" {
			existing.Name = name
		}
		if args != "{}" && len(args) > len(existing.Arguments) {
			existing.Arguments = args
		}
		return true
	}
	tc.completed = append(tc.completed, ToolCall{ID: callID, Name: name, Arguments: args})
	return true
}

// toolMessages surfaces the turn's calls as tool messages, one per call, in
// the shape state.HasToolCall / LastToolCall read: role tool, the call id
// and the tool name, with the call's ARGUMENTS as the content. That content
// is a placeholder for the request, not a tool-execution result (the
// result round trip is out of scope); it serializes as an AI SDK
// tool-result part with a json output when the arguments are a JSON object
// or array, else a text output carrying them verbatim.
func toolMessages(calls []ToolCall) []scenario.Message {
	out := make([]scenario.Message, len(calls))
	for i, c := range calls {
		out[i] = scenario.Message{Role: scenario.RoleTool, ToolCallID: c.ID, ToolName: c.Name, Content: c.Arguments}
	}
	return out
}
