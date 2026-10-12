package scenario

import (
	"bytes"
	"context"
	"flag"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

var update = flag.Bool("update", false, "rewrite golden files")

// capturingServer records the exact bodies POSTed to /api/scenario-events
// and can fail chosen attempts.
type capturingServer struct {
	*httptest.Server
	mu      sync.Mutex
	bodies  [][]byte
	headers []http.Header
	// fail returns a status for the n-th request (1-based), 0 to accept.
	fail func(n int, body []byte) int
}

func newCapturingServer(t *testing.T) *capturingServer {
	cs := &capturingServer{}
	cs.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		cs.mu.Lock()
		cs.bodies = append(cs.bodies, body)
		cs.headers = append(cs.headers, r.Header.Clone())
		n := len(cs.bodies)
		fail := cs.fail
		cs.mu.Unlock()
		if r.URL.Path != eventsAPIPath {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if fail != nil {
			if status := fail(n, body); status != 0 {
				w.WriteHeader(status)
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	t.Cleanup(cs.Close)
	return cs
}

func (cs *capturingServer) posted() [][]byte {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	return append([][]byte(nil), cs.bodies...)
}

func (cs *capturingServer) langwatch() LangWatchConfig {
	return LangWatchConfig{Endpoint: cs.URL, APIKey: "sk-lw-test", ProjectID: "project_test"}
}

// assertGolden compares the posted bodies, one per line inside a JSON
// array, with testdata/events/<name>.json.
func assertGolden(t *testing.T, name string, bodies [][]byte) {
	t.Helper()
	var buf bytes.Buffer
	buf.WriteString("[\n")
	for i, b := range bodies {
		buf.Write(b)
		if i < len(bodies)-1 {
			buf.WriteByte(',')
		}
		buf.WriteByte('\n')
	}
	buf.WriteString("]\n")
	path := filepath.Join("testdata", "events", name+".json")
	if *update {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing golden %s (run go test -run %s -update): %v", path, t.Name(), err)
	}
	if !bytes.Equal(want, buf.Bytes()) {
		t.Errorf("payloads differ from %s\n--- got\n%s\n--- want\n%s", path, buf.Bytes(), want)
	}
}

func goldenConfig(agent AgentAdapter, script ...ScriptStep) ScenarioConfig {
	sim, _ := userSim("unused")
	return ScenarioConfig{
		ID:          "scenario_golden",
		Name:        "golden scenario",
		Description: "a deterministic scenario",
		ThreadID:    "scenariothread_golden",
		SetID:       "golden-set",
		Metadata:    map[string]any{"env": "test"},
		Agents:      []AgentAdapter{agent, sim},
		Script:      script,
	}
}

func runGolden(t *testing.T, cs *capturingServer, cfg ScenarioConfig, granular bool) *ScenarioResult {
	t.Helper()
	res, err := Run(context.Background(), cfg,
		WithLangWatch(cs.langwatch()),
		WithBatchRunID("scenariobatch_golden"),
		WithRunID("scenariorun_golden"),
		WithGranularEventsForRun(granular),
	)
	if err != nil {
		t.Fatalf("run failed: %v", err)
	}
	return res
}

// toolCallingAgent returns a tool call, its result and a final answer
// without streaming.
var toolCallingAgent = AgentFunc(func(context.Context, AgentInput) (*AgentReturn, error) {
	return MessagesReturn(
		Message{Role: RoleAssistant, ToolCalls: []ToolCall{{ID: "call_1", Name: "get_weather", Arguments: `{"city": "Paris"}`}}},
		Message{Role: RoleTool, ToolCallID: "call_1", ToolName: "get_weather", Content: `{"temp": 21}`},
		AssistantMsg("It is 21 degrees in Paris."),
	), nil
})

func TestGoldenSnapshotMode(t *testing.T) {
	deterministic(t)
	cs := newCapturingServer(t)
	runGolden(t, cs, goldenConfig(toolCallingAgent, User("weather in paris?"), Agent(), Succeed("done")), false)
	assertGolden(t, "snapshot_mode", cs.posted())
}

func TestGoldenGranularNonStreamed(t *testing.T) {
	deterministic(t)
	cs := newCapturingServer(t)
	runGolden(t, cs, goldenConfig(toolCallingAgent, User("weather in paris?"), Agent(), Succeed("done")), true)
	assertGolden(t, "granular_non_streamed", cs.posted())
}

var streamingAgent = AgentFunc(func(_ context.Context, in AgentInput) (*AgentReturn, error) {
	in.Stream.TextDelta("Let me ")
	in.Stream.TextDelta("check.")
	in.Stream.ToolCallStart("call_1", "get_weather")
	in.Stream.ToolCallArgs("call_1", `{"city":`)
	in.Stream.ToolCallArgs("call_1", `"Paris"}`)
	in.Stream.ToolCallEnd("call_1")
	return MessageReturn(Message{
		Role:      RoleAssistant,
		Content:   "Let me check.",
		ToolCalls: []ToolCall{{ID: "call_1", Name: "get_weather", Arguments: `{"city":"Paris"}`}},
	}), nil
})

func TestGoldenGranularStreaming(t *testing.T) {
	deterministic(t)
	cs := newCapturingServer(t)
	runGolden(t, cs, goldenConfig(streamingAgent, User("weather in paris?"), Agent(), Succeed("done")), true)
	assertGolden(t, "granular_streaming", cs.posted())
}

var audioAgent = AgentFunc(func(context.Context, AgentInput) (*AgentReturn, error) {
	return MessageReturn(Message{Role: RoleAssistant, Parts: []Part{
		TextPart("hello there"),
		AudioPart(MediaTypePCM16, []byte{0, 1, 2, 3, 4, 5, 6, 7}),
	}}), nil
})

func TestGoldenGranularAudioEnd(t *testing.T) {
	deterministic(t)
	cs := newCapturingServer(t)
	runGolden(t, cs, goldenConfig(audioAgent, User("say hi"), Agent(), Succeed("done")), true)
	assertGolden(t, "granular_audio_end", cs.posted())
}

// reconcilingAgent first rolls the conversation back (a correction only a
// snapshot can express), then streams a message while another message lands
// before it (index drift).
var reconcilingAgent = AgentFunc(func(_ context.Context, in AgentInput) (*AgentReturn, error) {
	if _, err := in.ScenarioState.RollbackMessagesTo(0); err != nil {
		return nil, err
	}
	in.Stream.TextDelta("sorry, ")
	in.Executor.AddMessage(SystemMsg("a concurrent note"))
	return TextReturn("sorry, starting over"), nil
})

func TestGoldenSnapshotReconciliation(t *testing.T) {
	deterministic(t)
	cs := newCapturingServer(t)
	// The first attempt of the first snapshot fails transiently; its retry
	// must post the identical body (same timestamp, same ids).
	var failedOnce bool
	cs.fail = func(n int, body []byte) int {
		if !failedOnce && bytes.Contains(body, []byte(`"type":"SCENARIO_MESSAGE_SNAPSHOT"`)) {
			failedOnce = true
			return http.StatusServiceUnavailable
		}
		return 0
	}
	runGolden(t, cs, goldenConfig(reconcilingAgent, User("hi"), Agent(), Succeed("done")), true)
	assertGolden(t, "granular_snapshot_reconciliation", cs.posted())
}
