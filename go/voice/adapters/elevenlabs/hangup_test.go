package elevenlabs

import (
	"context"
	"errors"
	"testing"

	"github.com/coder/websocket"
	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
)

// An agent that hangs up on purpose (end_call, or a transfer that ends this
// session) concludes the scenario instead of failing its leftover turns.

func hangupFrame(tool string, overrides map[string]any) map[string]any {
	resp := map[string]any{
		"tool_name": tool, "tool_call_id": tool + "_abc123", "tool_type": "system",
		"is_error": false, "is_blocked": false, "event_id": 20, "is_called": true,
	}
	for k, v := range overrides {
		resp[k] = v
	}
	return map[string]any{"type": "agent_tool_response", "agent_tool_response": resp}
}

func TestAgentHangup(t *testing.T) {
	t.Parallel()
	for _, tool := range []string{"end_call", "transfer_to_agent", "transfer_to_number", "transfer_to_genesys"} {
		t.Run(tool+" ends the session", func(t *testing.T) {
			t.Parallel()
			f := newFake(t)
			tr := f.connect(f.options("agt-hangup"))
			if tr.AgentHungUp() {
				t.Fatal("hung up before any tool")
			}
			f.emit(hangupFrame(tool, nil))
			f.sync()
			if !tr.AgentHungUp() {
				t.Fatal("hangup not recorded")
			}
		})
	}

	for name, overrides := range map[string]map[string]any{
		"not called": {"is_called": false},
		"errored":    {"is_error": true},
		"blocked":    {"is_blocked": true},
		"unrelated":  {"tool_name": "language_detection"},
	} {
		t.Run("no hangup when the tool was "+name, func(t *testing.T) {
			t.Parallel()
			f := newFake(t)
			tr := f.connect(f.options("agt-hangup"))
			f.emit(hangupFrame("end_call", overrides))
			f.sync()
			if tr.AgentHungUp() {
				t.Fatal("hangup recorded")
			}
		})
	}
}

func TestTurnAfterHangupConcludes(t *testing.T) {
	t.Parallel()
	f := newFake(t)
	a := must(NewAgent(f.options("agt-hangup")))
	ctx := context.Background()
	if err := a.ConvAI().Connect(ctx); err != nil {
		t.Fatal(err)
	}
	<-f.connected
	f.emit(hangupFrame("end_call", nil))
	f.waitFor(a.ConvAI().AgentHungUp, "the hangup")
	f.closeSession(websocket.StatusNormalClosure) // EL closes right after the tool frame
	waitFor(t, func() bool { return !a.ConvAI().IsConnected() }, "the close")

	msgs, err := a.Turn(ctx, scenario.AgentInput{})
	if err != nil || len(msgs) != 0 {
		t.Fatalf("turn after hangup: msgs %v err %v", msgs, err)
	}
	_ = a.ConvAI().Disconnect(ctx)
}

func TestTurnAfterDroppedTransportFails(t *testing.T) {
	t.Parallel()
	f := newFake(t)
	a := must(NewAgent(f.options("agt-hangup")))
	ctx := context.Background()
	if err := a.ConvAI().Connect(ctx); err != nil {
		t.Fatal(err)
	}
	_ = a.ConvAI().Disconnect(ctx)
	if a.ConvAI().AgentHungUp() {
		t.Fatal("hangup recorded without a hangup tool")
	}
	_, err := a.Turn(ctx, scenario.AgentInput{})
	var pending *voice.PendingTransportError
	if !errors.As(err, &pending) {
		t.Fatalf("err %v, want a PendingTransportError", err)
	}
}
