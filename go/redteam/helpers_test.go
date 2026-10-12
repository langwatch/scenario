package redteam

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

func TestMain(m *testing.M) {
	os.Setenv("SCENARIO_DISABLE_SIMULATION_REPORT_INFO", "1")
	os.Setenv("SCENARIO_HEADLESS", "1")
	os.Setenv("SCENARIO_LOG_LEVEL", "off")
	os.Unsetenv("LANGWATCH_API_KEY")
	os.Unsetenv("LANGWATCH_PROJECT_ID")
	// Runs must not write reports into the package directory; the report
	// tests turn it back on with a temporary directory.
	os.Setenv(EnvReport, "0")
	os.Unsetenv(EnvReportDir)
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	os.Exit(m.Run())
}

// fakeLLM answers with a function of the request and records the requests.
type fakeLLM struct {
	mu       sync.Mutex
	requests []scenario.InferenceParams
	answer   func(n int, p scenario.InferenceParams) (string, error)
}

func (f *fakeLLM) Inference(_ context.Context, p scenario.InferenceParams) (*scenario.InferenceResult, error) {
	f.mu.Lock()
	f.requests = append(f.requests, p)
	n := len(f.requests)
	f.mu.Unlock()
	text, err := f.answer(n, p)
	if err != nil {
		return nil, err
	}
	return &scenario.InferenceResult{Message: scenario.AssistantMsg(text)}, nil
}

func (f *fakeLLM) calls() []scenario.InferenceParams {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]scenario.InferenceParams(nil), f.requests...)
}

// fixed answers every request with text.
func fixed(text string) *fakeLLM {
	return &fakeLLM{answer: func(int, scenario.InferenceParams) (string, error) { return text, nil }}
}

// sequence answers the n-th request with texts[n-1], repeating the last.
func sequence(texts ...string) *fakeLLM {
	return &fakeLLM{answer: func(n int, _ scenario.InferenceParams) (string, error) {
		return texts[min(n, len(texts))-1], nil
	}}
}

// isScorerRequest reports whether a metaprompt-model request is a scoring
// request rather than plan generation.
func isScorerRequest(p scenario.InferenceParams) bool {
	return strings.HasPrefix(p.Messages[0].Content, scorePromptStart)
}

// recordingJudge records the judgment requests and passes.
type recordingJudge struct {
	mu       sync.Mutex
	messages []int
}

func (j *recordingJudge) Role() scenario.AgentRole { return scenario.AgentRoleJudge }
func (j *recordingJudge) Criteria() []string       { return []string{"Agent refused all attacks"} }
func (j *recordingJudge) Call(_ context.Context, in scenario.AgentInput) (*scenario.AgentReturn, error) {
	if in.JudgmentRequest == nil {
		return nil, nil
	}
	j.mu.Lock()
	j.messages = append(j.messages, len(in.Messages))
	j.mu.Unlock()
	return scenario.VerdictReturn(scenario.JudgeResult{
		Success: true, Reasoning: "Defense held",
		MetCriteria: []string{"Agent refused all attacks"}, UnmetCriteria: []string{},
	}), nil
}

func (j *recordingJudge) calls() []int {
	j.mu.Lock()
	defer j.mu.Unlock()
	return append([]int(nil), j.messages...)
}

// target answers every user message with respond(last user text) and
// records what it saw.
type target struct {
	mu      sync.Mutex
	seen    [][]scenario.Message
	respond func(last string) string
}

func (t *target) Role() scenario.AgentRole { return scenario.AgentRoleAgent }
func (t *target) Call(_ context.Context, in scenario.AgentInput) (*scenario.AgentReturn, error) {
	t.mu.Lock()
	t.seen = append(t.seen, in.Messages)
	t.mu.Unlock()
	last := ""
	if n := len(in.Messages); n > 0 {
		last = in.Messages[n-1].Text()
	}
	return scenario.TextReturn(t.respond(last)), nil
}

func (t *target) inputs() [][]scenario.Message {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([][]scenario.Message(nil), t.seen...)
}

// run executes a marathon of the agent against the target.
func run(t *testing.T, a *Agent, tgt scenario.AgentAdapter, judge scenario.AgentAdapter, opts ...MarathonOption) (*scenario.ScenarioResult, error) {
	t.Helper()
	return scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name:        "red team test",
		Description: "A bank support agent",
		Agents:      []scenario.AgentAdapter{tgt, a, judge},
		Script:      a.MarathonScript(opts...),
		MaxTurns:    100,
	})
}

// mustAgent fails the test on a construction error.
func mustAgent(t *testing.T) func(*Agent, error) *Agent {
	return func(a *Agent, err error) *Agent {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return a
	}
}

// attackerHistory returns the messages the attacker model gets next: the
// system prompt and the private history.
func (a *Agent) attackerHistory() []scenario.Message {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := []scenario.Message{scenario.SystemMsg(a.systemPrompt)}
	return append(out, a.history...)
}

// setTurnScore caches a score as if a turn had been scored.
func (a *Agent) setTurnScore(turn int, score float64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.setScore(turn, turnScore{score: score})
}

func intPtr(n int) *int { return &n }
