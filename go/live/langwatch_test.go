//go:build integration

package live_test

import (
	"context"
	"slices"
	"sync"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/internal/livetest"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
)

// readBackTimeout bounds a run plus its ingestion by LangWatch.
const readBackTimeout = 5 * time.Minute

// eventLog records the types of the events a run emitted.
type eventLog struct {
	mu    sync.Mutex
	types map[scenario.EventType]int
}

func (l *eventLog) listen(ev scenario.Event) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.types == nil {
		l.types = map[scenario.EventType]int{}
	}
	l.types[ev.Type]++
}

func (l *eventLog) count(t scenario.EventType) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.types[t]
}

// TestLiveLangWatchRoundTripSnapshot reports a judged run with message
// snapshot events and reads it back. Needs LANGWATCH_API_KEY and
// OPENAI_API_KEY.
func TestLiveLangWatchRoundTripSnapshot(t *testing.T) { langWatchRoundTrip(t, false) }

// TestLiveLangWatchRoundTripGranular reports a judged run with granular
// message events (WithGranularEventsForRun(true)) and reads it back. Needs
// LANGWATCH_API_KEY and OPENAI_API_KEY.
func TestLiveLangWatchRoundTripGranular(t *testing.T) { langWatchRoundTrip(t, true) }

// langWatchRoundTrip runs a scenario with reporting on, then reads the run
// back through the simulation runs API and checks the messages, verdict,
// criteria and the traces of the agent's messages arrived.
func langWatchRoundTrip(t *testing.T, granular bool) {
	lw := livetest.RequireLangWatch(t)
	llm := requireOpenAI(t)
	ctx := livetest.Context(t, readBackTimeout)
	mode := "snapshot"
	if granular {
		mode = "granular"
	}
	name := "go live: langwatch round trip (" + mode + ")"
	criteria := []string{"The agent suggests at least one thing to do in Lisbon"}
	events := &eventLog{}
	res, err := scenario.Run(ctx, scenario.ScenarioConfig{
		Name:        name,
		Description: "A traveller with one free day in Lisbon asks what to do.",
		Agents: []scenario.AgentAdapter{
			&livetest.ChatAgent{LLM: llm, Model: model(), System: "You are a concise travel assistant. Answer in at most two sentences."},
			userSimulator(llm),
			judge(llm, criteria...),
		},
		Script: []scenario.ScriptStep{
			scenario.User("I have one free day in Lisbon, what should I do?"),
			scenario.Agent(),
			scenario.Judge(),
		},
		MaxTurns: 2,
		SetID:    livetest.SetID,
	}, scenario.WithLangWatch(lw.Config), scenario.WithGranularEventsForRun(granular), scenario.WithEventListener(events.listen))
	livetest.AssertVerdict(t, res, err, criteria)

	// The run emitted the events of its mode.
	if events.count(scenario.EventRunStarted) != 1 || events.count(scenario.EventRunFinished) != 1 {
		t.Errorf("run events %v", events.types)
	}
	if granular {
		for _, typ := range []scenario.EventType{scenario.EventTextMessageStart, scenario.EventTextMessageContent, scenario.EventTextMessageEnd} {
			if events.count(typ) == 0 {
				t.Errorf("granular run emitted no %s: %v", typ, events.types)
			}
		}
	} else if events.count(scenario.EventMessageSnapshot) == 0 || events.count(scenario.EventTextMessageStart) > 0 {
		t.Errorf("snapshot run events %v", events.types)
	}

	run := lw.WaitSimulationRun(t, ctx, res.RunID, func(r *livetest.SimulationRun) bool {
		return livetest.Finished(r) && len(r.Messages) >= 2
	})
	t.Logf("run in LangWatch: %s", run.PlatformURL)
	if run.Status != "SUCCESS" || run.Results.Verdict != "success" {
		t.Errorf("status %q verdict %q, want SUCCESS/success", run.Status, run.Results.Verdict)
	}
	if run.Name != name || run.ScenarioSetID != livetest.SetID || run.ScenarioRunID != res.RunID {
		t.Errorf("run identity: name %q set %q id %q", run.Name, run.ScenarioSetID, run.ScenarioRunID)
	}
	if run.Results.Reasoning != res.Reasoning {
		t.Errorf("reasoning %q, want %q", run.Results.Reasoning, res.Reasoning)
	}
	if !slices.Equal(run.Results.MetCriteria, criteria) || len(run.Results.UnmetCriteria) != 0 {
		t.Errorf("criteria met %q unmet %q", run.Results.MetCriteria, run.Results.UnmetCriteria)
	}
	if len(run.Results.Criteria) != len(criteria) {
		t.Errorf("per-criterion verdicts %+v", run.Results.Criteria)
	} else if c := run.Results.Criteria[0]; c.Criterion != criteria[0] || c.Status != "passed" || c.Reasoning == "" {
		t.Errorf("criterion verdict %+v", c)
	}
	assertMessagesArrived(t, res.Messages, run)

	// The trace of every agent message reached LangWatch.
	for _, id := range scenario.MessageTraceIDs(res.Messages) {
		spans := lw.WaitTrace(t, ctx, id, func(s []livetest.TraceSpan) bool {
			return livetest.HasSpan(s, "ChatAgent.call")
		})
		t.Logf("trace %s: %v", id, livetest.SpanNames(spans))
	}
	if len(scenario.MessageTraceIDs(res.Messages)) == 0 {
		t.Error("no message carries a trace id")
	}
}

// assertMessagesArrived checks the user and assistant text messages of the
// run are in the platform's copy, in order.
func assertMessagesArrived(t *testing.T, sent []scenario.Message, run *livetest.SimulationRun) {
	t.Helper()
	if run.MessagesTruncated {
		t.Fatalf("platform truncated the %d messages", len(run.Messages))
	}
	next := 0
	for _, m := range sent {
		if (m.Role != scenario.RoleUser && m.Role != scenario.RoleAssistant) || m.Text() == "" {
			continue
		}
		found := false
		for next < len(run.Messages) {
			got := run.Messages[next]
			next++
			if got.Role == string(m.Role) && got.Content == m.Text() {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("message %s %q missing from LangWatch messages %+v", m.Role, m.Text(), run.Messages)
			return
		}
	}
}

// TestLiveTracingExportReachesLangWatch checks the spans of a run, the
// SDK's own and one the agent starts, are exported to LangWatch and
// readable through the trace API the remote trace fetcher uses. Needs
// LANGWATCH_API_KEY only (the run is scripted).
func TestLiveTracingExportReachesLangWatch(t *testing.T) {
	lw := livetest.RequireLangWatch(t)
	ctx := livetest.Context(t, readBackTimeout)
	const agentSpan = "live.lookup_itinerary"
	agent := scenario.AgentFunc(func(ctx context.Context, _ scenario.AgentInput) (*scenario.AgentReturn, error) {
		_, span := otel.Tracer("go-live-agent").Start(ctx, agentSpan)
		span.SetAttributes(
			attribute.String("langwatch.span.type", "tool"),
			attribute.String("langwatch.input", `{"type":"text","value":"Lisbon"}`),
			attribute.String("langwatch.output", `{"type":"text","value":"Belem, Alfama"}`),
		)
		span.End()
		return scenario.TextReturn("Visit Belem in the morning and Alfama in the evening."), nil
	})
	res, err := scenario.Run(ctx, scenario.ScenarioConfig{
		Name:        "go live: tracing export",
		Description: "A traveller asks for a day plan in Lisbon.",
		Agents:      []scenario.AgentAdapter{agent},
		Script: []scenario.ScriptStep{
			scenario.User("Plan my day in Lisbon."),
			scenario.Agent(),
			scenario.Succeed("scripted"),
		},
		SetID: livetest.SetID,
	}, scenario.WithLangWatch(lw.Config))
	if err != nil || !res.Success {
		t.Fatalf("run: %v %+v", err, res)
	}
	ids := scenario.MessageTraceIDs(res.Messages)
	if len(ids) == 0 {
		t.Fatal("the agent message carries no trace id")
	}
	spans := lw.WaitTrace(t, ctx, ids[0], func(s []livetest.TraceSpan) bool {
		return livetest.HasSpan(s, agentSpan) && livetest.HasSpan(s, "Scenario Turn")
	})
	byID := map[string]livetest.TraceSpan{}
	for _, s := range spans {
		byID[s.SpanID] = s
		if s.TraceID != "" && s.TraceID != ids[0] {
			t.Errorf("span %s in trace %s, want %s", s.Name, s.TraceID, ids[0])
		}
	}
	for _, s := range spans {
		if s.Name == agentSpan {
			if _, ok := byID[s.ParentID]; !ok {
				t.Errorf("agent span parent %q is not in the trace %v", s.ParentID, livetest.SpanNames(spans))
			}
		}
	}
}
