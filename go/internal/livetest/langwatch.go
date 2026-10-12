package livetest

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
)

// pollInterval is how often the readers poll LangWatch while waiting for
// ingestion.
const pollInterval = 2 * time.Second

// LangWatch reads runs and traces back from a LangWatch project, through
// the same public API the LangWatch SDKs and the remote trace fetcher use:
// GET /api/simulation-runs/{scenarioRunId} and GET /api/trace/{traceId}.
type LangWatch struct {
	// Config is the resolved project (endpoint, key, project id).
	Config scenario.LangWatchConfig
	http   *http.Client
}

// RequireLangWatch skips the test without LANGWATCH_API_KEY and returns a
// reader for the project it names (LANGWATCH_ENDPOINT is optional).
func RequireLangWatch(t testing.TB) *LangWatch {
	t.Helper()
	Require(t, "LANGWATCH_API_KEY")
	return &LangWatch{
		Config: scenario.ResolveLangWatch(scenario.LangWatchConfig{}),
		http:   &http.Client{Timeout: 30 * time.Second},
	}
}

// SimulationRun is a run as GET /api/simulation-runs/{id} returns it.
type SimulationRun struct {
	ScenarioID    string `json:"scenarioId"`
	BatchRunID    string `json:"batchRunId"`
	ScenarioRunID string `json:"scenarioRunId"`
	ScenarioSetID string `json:"scenarioSetId"`
	Name          string `json:"name"`
	Description   string `json:"description"`
	// Status is IN_PROGRESS until the finished event lands, then SUCCESS,
	// FAILED or ERROR.
	Status  string            `json:"status"`
	Results *SimulationResult `json:"results"`
	// Messages are the conversation as the platform rebuilt it from the
	// snapshot or granular message events.
	Messages          []SimulationMessage `json:"messages"`
	MessagesTruncated bool                `json:"messagesTruncated"`
	DurationInMs      float64             `json:"durationInMs"`
	PlatformURL       string              `json:"platformUrl"`
}

// SimulationResult is the verdict part of a run.
type SimulationResult struct {
	Verdict       string   `json:"verdict"`
	Reasoning     string   `json:"reasoning"`
	MetCriteria   []string `json:"metCriteria"`
	UnmetCriteria []string `json:"unmetCriteria"`
	Criteria      []struct {
		Criterion string `json:"criterion"`
		Status    string `json:"status"`
		Reasoning string `json:"reasoning"`
	} `json:"criteria"`
	Error       string `json:"error"`
	Evaluations []struct {
		EvaluatorID string   `json:"evaluatorId"`
		Name        string   `json:"name"`
		Status      string   `json:"status"`
		Required    bool     `json:"required"`
		Passed      *bool    `json:"passed"`
		Score       *float64 `json:"score"`
	} `json:"evaluations"`
}

// SimulationMessage is one message of a run, with its content flattened to
// a string by the platform.
type SimulationMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// TraceSpan is a span as GET /api/trace/{traceId} returns it.
type TraceSpan struct {
	SpanID   string `json:"span_id"`
	TraceID  string `json:"trace_id"`
	ParentID string `json:"parent_id"`
	Type     string `json:"type"`
	Name     string `json:"name"`
}

// get GETs path and decodes a 2xx JSON body into out. found is false on a
// 404, which the platform answers until ingestion caught up.
func (lw *LangWatch) get(ctx context.Context, path string, out any) (found bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(lw.Config.Endpoint, "/")+path, nil)
	if err != nil {
		return false, err
	}
	// The same dual auth the trace fetcher sends: older routes read
	// X-Auth-Token, newer ones a Bearer token (with a project for PATs).
	req.Header.Set("X-Auth-Token", lw.Config.APIKey)
	req.Header.Set("Authorization", "Bearer "+lw.Config.APIKey)
	if lw.Config.ProjectID != "" {
		req.Header.Set("X-Project-Id", lw.Config.ProjectID)
	}
	resp, err := lw.http.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode == http.StatusNotFound {
		return false, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return false, fmt.Errorf("GET %s: %d %s", path, resp.StatusCode, truncate(string(body), 300))
	}
	return true, json.Unmarshal(body, out)
}

// SimulationRun reads one run; nil when the platform does not know it yet.
func (lw *LangWatch) SimulationRun(ctx context.Context, scenarioRunID string) (*SimulationRun, error) {
	var run SimulationRun
	found, err := lw.get(ctx, "/api/simulation-runs/"+url.PathEscape(scenarioRunID), &run)
	if err != nil || !found {
		return nil, err
	}
	return &run, nil
}

// WaitSimulationRun polls the run until done accepts it, failing the test
// at the context deadline with the last state seen.
func (lw *LangWatch) WaitSimulationRun(t testing.TB, ctx context.Context, scenarioRunID string, done func(*SimulationRun) bool) *SimulationRun {
	t.Helper()
	var last *SimulationRun
	var lastErr error
	for {
		run, err := lw.SimulationRun(ctx, scenarioRunID)
		if err == nil && run != nil {
			last = run
			if done(run) {
				return run
			}
		}
		if err != nil {
			lastErr = err
		}
		select {
		case <-ctx.Done():
			t.Fatalf("run %s did not reach the expected state in LangWatch: last=%+v err=%v", scenarioRunID, last, lastErr)
			return nil
		case <-time.After(pollInterval):
		}
	}
}

// Finished reports whether a run has its finished event.
func Finished(run *SimulationRun) bool {
	return run.Status != "" && run.Status != "IN_PROGRESS" && run.Results != nil
}

// Trace reads the spans of one trace; nil when not ingested yet.
func (lw *LangWatch) Trace(ctx context.Context, traceID string) ([]TraceSpan, error) {
	var body struct {
		Spans []TraceSpan `json:"spans"`
	}
	found, err := lw.get(ctx, "/api/trace/"+url.PathEscape(traceID), &body)
	if err != nil || !found {
		return nil, err
	}
	return body.Spans, nil
}

// WaitTrace polls the trace until done accepts its spans, failing the test
// at the context deadline.
func (lw *LangWatch) WaitTrace(t testing.TB, ctx context.Context, traceID string, done func([]TraceSpan) bool) []TraceSpan {
	t.Helper()
	var last []TraceSpan
	var lastErr error
	for {
		spans, err := lw.Trace(ctx, traceID)
		if err == nil && spans != nil {
			last = spans
			if done(spans) {
				return spans
			}
		}
		if err != nil {
			lastErr = err
		}
		select {
		case <-ctx.Done():
			t.Fatalf("trace %s did not reach the expected state in LangWatch: %d spans %v, err=%v", traceID, len(last), SpanNames(last), lastErr)
			return nil
		case <-time.After(pollInterval):
		}
	}
}

// SpanNames lists the names of spans.
func SpanNames(spans []TraceSpan) []string {
	out := make([]string, len(spans))
	for i, s := range spans {
		out[i] = s.Name
	}
	return out
}

// HasSpan reports whether a span named name is among spans.
func HasSpan(spans []TraceSpan, name string) bool {
	for _, s := range spans {
		if s.Name == name {
			return true
		}
	}
	return false
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
