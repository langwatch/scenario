package scenario

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

const (
	rtThread = "thread-1"
	rtTrace  = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1"
)

// apiSpanJSON is a trace API span as the platform sends it.
func apiSpanJSON(overrides map[string]any) map[string]any {
	s := map[string]any{
		"span_id":    "b000000000000001",
		"trace_id":   rtTrace,
		"type":       "tool",
		"name":       "get_weather",
		"timestamps": map[string]any{"started_at": 1_700_000_000_000, "finished_at": 1_700_000_000_500},
	}
	for k, v := range overrides {
		s[k] = v
	}
	return s
}

type apiCall struct {
	url     string
	headers http.Header
}

// fakeTraceAPI answers each request with the next scripted result: a span
// list, "404", "error" (a 500), or "stall" (never answers). The last result
// repeats once the script runs out.
type fakeTraceAPI struct {
	mu     sync.Mutex
	script []any
	calls  []apiCall
	srv    *httptest.Server
	answer func(r *http.Request) any
}

func newFakeTraceAPI(t *testing.T, script ...any) *fakeTraceAPI {
	f := &fakeTraceAPI{script: script}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.calls = append(f.calls, apiCall{url: r.URL.String(), headers: r.Header.Clone()})
		var next any
		if f.answer != nil {
			next = f.answer(r)
		} else {
			next = f.script[0]
			if len(f.script) > 1 {
				f.script = f.script[1:]
			}
		}
		f.mu.Unlock()
		switch v := next.(type) {
		case string:
			switch v {
			case "404":
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`{"error":"not found"}`))
			case "stall":
				<-r.Context().Done()
			default:
				w.WriteHeader(http.StatusInternalServerError)
			}
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"trace_id": rtTrace, "spans": v})
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeTraceAPI) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func (f *fakeTraceAPI) target(c *SpanCollector, timeout, quiet time.Duration, ids ...string) TraceSettleTarget {
	if len(ids) == 0 {
		ids = []string{rtTrace}
	}
	return TraceSettleTarget{
		ThreadID: rtThread, TraceIDs: ids, Collector: c,
		LangWatch: LangWatchConfig{Endpoint: f.srv.URL, APIKey: "key-123"},
		Timeout:   timeout, QuietPeriod: quiet,
	}
}

func testFetcher() *LangWatchTraceFetcher {
	return NewRemoteTraceFetcher(RemoteTraceFetcherOptions{PollInterval: time.Millisecond})
}

func spanNames(spans []sdktrace.ReadOnlySpan) []string {
	out := make([]string, len(spans))
	for i, s := range spans {
		out[i] = s.Name()
	}
	return out
}

func spanAttr(s sdktrace.ReadOnlySpan, key string) (attribute.Value, bool) {
	for _, kv := range s.Attributes() {
		if string(kv.Key) == key {
			return kv.Value, true
		}
	}
	return attribute.Value{}, false
}

func errorReason(t *testing.T, spans []sdktrace.ReadOnlySpan) string {
	t.Helper()
	for _, s := range spans {
		if s.Name() == SpanCollectionErrorName {
			v, _ := spanAttr(s, "langwatch.span_collection.error.reason")
			return v.AsString()
		}
	}
	t.Fatalf("no error span in %v", spanNames(spans))
	return ""
}

func localSpan(spanID, name string) sdktrace.ReadOnlySpan {
	tid, _ := parseTraceID(rtTrace)
	sid, _ := parseSpanID(spanID)
	return tracetest.SpanStub{
		Name:        name,
		SpanContext: trace.NewSpanContext(trace.SpanContextConfig{TraceID: tid, SpanID: sid}),
		StartTime:   time.Unix(1_700_000_000, 0),
		EndTime:     time.Unix(1_700_000_001, 0),
		Attributes:  []attribute.KeyValue{attribute.String(threadIDKey, rtThread)},
	}.Snapshot()
}

// fixedIDs generates the given span ids in the given trace.
type fixedIDs struct {
	traceID trace.TraceID
	spans   []trace.SpanID
}

func (g *fixedIDs) NewIDs(context.Context) (trace.TraceID, trace.SpanID) {
	return g.traceID, g.NewSpanID(context.Background(), g.traceID)
}

func (g *fixedIDs) NewSpanID(context.Context, trace.TraceID) trace.SpanID {
	id := g.spans[0]
	g.spans = g.spans[1:]
	return id
}

// startProcessSpans starts (and leaves open) spans with the given ids, so
// the collector knows this process started them.
func startProcessSpans(c *SpanCollector, traceID string, spanIDs ...string) {
	tid, _ := parseTraceID(traceID)
	g := &fixedIDs{traceID: tid}
	for _, s := range spanIDs {
		sid, _ := parseSpanID(s)
		g.spans = append(g.spans, sid)
	}
	tp := sdktrace.NewTracerProvider(sdktrace.WithIDGenerator(g), sdktrace.WithSpanProcessor(c))
	tr := tp.Tracer("test")
	for range spanIDs {
		_, _ = tr.Start(context.Background(), "open")
	}
}

func TestRemoteFetcherFeedsConvertedSpans(t *testing.T) {
	c := NewSpanCollector()
	api := newFakeTraceAPI(t, []any{apiSpanJSON(nil)})
	testFetcher().SettleWait(context.Background(), api.target(c, 5*time.Second, 0))

	if api.count() != 1 {
		t.Fatalf("calls %d", api.count())
	}
	spans := c.SpansForThread(rtThread)
	if len(spans) != 1 || spans[0].Name() != "get_weather" {
		t.Fatalf("spans %v", spanNames(spans))
	}
	if v, _ := spanAttr(spans[0], "langwatch.span.type"); v.AsString() != "tool" {
		t.Errorf("span type %v", v)
	}
	if v, _ := spanAttr(spans[0], threadIDKey); v.AsString() != rtThread {
		t.Errorf("thread %v", v)
	}
	call := api.calls[0]
	if call.url != "/api/trace/"+rtTrace {
		t.Errorf("url %s", call.url)
	}
	if call.headers.Get("X-Auth-Token") != "key-123" || call.headers.Get("Authorization") != "Bearer key-123" {
		t.Errorf("auth headers %v", call.headers)
	}
	if _, ok := call.headers["X-Project-Id"]; ok {
		t.Error("X-Project-Id must be omitted without a project")
	}
}

func TestRemoteFetcherScopesProject(t *testing.T) {
	c := NewSpanCollector()
	api := newFakeTraceAPI(t, []any{apiSpanJSON(nil)})
	target := api.target(c, 5*time.Second, 0)
	target.LangWatch.ProjectID = "project-abc"
	testFetcher().SettleWait(context.Background(), target)
	if got := api.calls[0].headers.Get("X-Project-Id"); got != "project-abc" {
		t.Errorf("X-Project-Id %q", got)
	}
}

func TestRemoteFetcherStalledRequestStopsAtDeadline(t *testing.T) {
	c := NewSpanCollector()
	api := newFakeTraceAPI(t, "stall")
	start := time.Now()
	testFetcher().SettleWait(context.Background(), api.target(c, 30*time.Millisecond, 0))
	if time.Since(start) > 5*time.Second {
		t.Fatal("waited past the deadline")
	}
	spans := c.SpansForThread(rtThread)
	if len(spans) != 1 {
		t.Fatalf("spans %v", spanNames(spans))
	}
	reason := errorReason(t, spans)
	if !strings.Contains(reason, "no agent spans arrived") || strings.Contains(reason, "abort") {
		t.Errorf("reason %q", reason)
	}
}

func TestRemoteFetcherPollsUntilTraceArrives(t *testing.T) {
	c := NewSpanCollector()
	api := newFakeTraceAPI(t, "404", "404", []any{apiSpanJSON(nil)})
	testFetcher().SettleWait(context.Background(), api.target(c, 5*time.Second, 0))
	if api.count() != 3 || len(c.SpansForThread(rtThread)) != 1 {
		t.Fatalf("calls %d spans %d", api.count(), len(c.SpansForThread(rtThread)))
	}
}

func TestRemoteFetcherWaitsOutQuietPeriod(t *testing.T) {
	c := NewSpanCollector()
	api := newFakeTraceAPI(t, []any{apiSpanJSON(nil)})
	start := time.Now()
	testFetcher().SettleWait(context.Background(), api.target(c, 5*time.Second, 50*time.Millisecond))
	if api.count() <= 1 || time.Since(start) < 50*time.Millisecond {
		t.Fatalf("calls %d after %v", api.count(), time.Since(start))
	}
	if len(c.SpansForThread(rtThread)) != 1 {
		t.Fatal("span not kept")
	}
}

func TestRemoteFetcherFetchesLateLeaf(t *testing.T) {
	c := NewSpanCollector()
	root := apiSpanJSON(map[string]any{"name": "agent.request"})
	leaf := apiSpanJSON(map[string]any{"span_id": "b000000000000002", "name": "tools.late_leaf", "parent_id": "b000000000000001"})
	api := newFakeTraceAPI(t, []any{root}, []any{root, leaf})
	testFetcher().SettleWait(context.Background(), api.target(c, 5*time.Second, 30*time.Millisecond))
	if !slices.Contains(spanNames(c.SpansForThread(rtThread)), "tools.late_leaf") {
		t.Fatal("late leaf missing")
	}
}

func TestRemoteFetcherDeadlineSettlesCompleteTraceCleanly(t *testing.T) {
	c := NewSpanCollector()
	api := newFakeTraceAPI(t, []any{apiSpanJSON(nil)})
	ok := testFetcher().SettleWait(context.Background(), api.target(c, 30*time.Millisecond, time.Minute))
	if names := spanNames(c.SpansForThread(rtThread)); !ok || !slices.Equal(names, []string{"get_weather"}) {
		t.Fatalf("settled %v spans %v", ok, names)
	}
}

func TestRemoteFetcherCandidateDroppedByFailedPolls(t *testing.T) {
	c := NewSpanCollector()
	api := newFakeTraceAPI(t, []any{apiSpanJSON(nil)}, "error")
	ok := testFetcher().SettleWait(context.Background(), api.target(c, 40*time.Millisecond, time.Minute))
	spans := c.SpansForThread(rtThread)
	if ok || !slices.Contains(spanNames(spans), "get_weather") {
		t.Fatalf("settled %v spans %v", ok, spanNames(spans))
	}
	if reason := errorReason(t, spans); !strings.Contains(reason, "500") || !strings.Contains(reason, "still incomplete") {
		t.Errorf("reason %q", reason)
	}
}

func TestRemoteFetcherNegativeQuietPeriodUsesDefault(t *testing.T) {
	c := NewSpanCollector()
	api := newFakeTraceAPI(t, []any{apiSpanJSON(nil)})
	ok := testFetcher().SettleWait(context.Background(), api.target(c, 40*time.Millisecond, -time.Millisecond))
	if !ok || api.count() <= 1 {
		t.Fatalf("settled %v after %d calls", ok, api.count())
	}
}

func TestRemoteFetcherIgnoresRepeatedPartialChunk(t *testing.T) {
	c := NewSpanCollector()
	orphan := apiSpanJSON(map[string]any{"span_id": "b000000000000002", "name": "tools.round_one", "parent_id": "b000000000000001"})
	full := []any{
		apiSpanJSON(map[string]any{"name": "agent.request"}),
		orphan,
		apiSpanJSON(map[string]any{"span_id": "b000000000000003", "name": "db.write", "parent_id": "b000000000000001"}),
	}
	api := newFakeTraceAPI(t, []any{orphan}, []any{orphan}, []any{orphan}, full)
	testFetcher().SettleWait(context.Background(), api.target(c, 5*time.Second, 0))
	names := spanNames(c.SpansForThread(rtThread))
	if api.count() != 4 || !slices.Contains(names, "db.write") || !slices.Contains(names, "agent.request") {
		t.Fatalf("calls %d names %v", api.count(), names)
	}
}

func TestRemoteFetcherIncompleteTraceAtDeadline(t *testing.T) {
	c := NewSpanCollector()
	api := newFakeTraceAPI(t, []any{apiSpanJSON(map[string]any{"parent_id": "b0000000000000ff"})})
	f := testFetcher()
	f.SettleWait(context.Background(), api.target(c, 40*time.Millisecond, 0))
	atDeadline := api.count()
	if atDeadline <= 2 {
		t.Fatalf("calls %d", atDeadline)
	}
	f.SettleWait(context.Background(), api.target(c, 40*time.Millisecond, 0))
	if api.count() != atDeadline {
		t.Error("a failed trace must not be polled again")
	}
	spans := c.SpansForThread(rtThread)
	if !slices.Contains(spanNames(spans), "get_weather") {
		t.Fatal("collected span dropped")
	}
	if reason := errorReason(t, spans); !strings.Contains(reason, "still incomplete") {
		t.Errorf("reason %q", reason)
	}
}

func TestRemoteFetcherIgnoresLocalEchoParents(t *testing.T) {
	c := NewSpanCollector()
	c.Add(localSpan("b000000000000002", "adapter.call"))
	api := newFakeTraceAPI(t, []any{
		apiSpanJSON(map[string]any{"span_id": "b000000000000002", "name": "adapter.call", "parent_id": "b000000000000001"}),
		apiSpanJSON(map[string]any{"span_id": "c000000000000001", "name": "agent.request", "parent_id": "b000000000000002"}),
	})
	testFetcher().SettleWait(context.Background(), api.target(c, 5*time.Second, 0))
	names := spanNames(c.SpansForThread(rtThread))
	if api.count() != 1 || !slices.Contains(names, "agent.request") || slices.Contains(names, SpanCollectionErrorName) {
		t.Fatalf("calls %d names %v", api.count(), names)
	}
}

func TestRemoteFetcherNeverSettlesOnLocalSpansOnly(t *testing.T) {
	c := NewSpanCollector()
	c.Add(localSpan("b000000000000001", "local.op"))
	api := newFakeTraceAPI(t, []any{apiSpanJSON(map[string]any{"name": "local.op"})})
	f := testFetcher()
	f.SettleWait(context.Background(), api.target(c, 60*time.Millisecond, 0))
	atTimeout := api.count()
	if atTimeout <= 3 {
		t.Fatalf("calls %d", atTimeout)
	}
	f.SettleWait(context.Background(), api.target(c, 60*time.Millisecond, 0))
	if api.count() != atTimeout {
		t.Error("failed trace polled again")
	}
	if reason := errorReason(t, c.SpansForThread(rtThread)); !strings.Contains(reason, "no agent spans arrived") {
		t.Errorf("reason %q", reason)
	}
}

func TestRemoteFetcherSkipsSettledIDs(t *testing.T) {
	c := NewSpanCollector()
	api := newFakeTraceAPI(t, []any{apiSpanJSON(nil)})
	f := testFetcher()
	f.SettleWait(context.Background(), api.target(c, 5*time.Second, 0))
	n := api.count()
	f.SettleWait(context.Background(), api.target(c, 5*time.Second, 0))
	if api.count() != n {
		t.Error("settled trace fetched again")
	}
}

func TestRemoteFetcherSettlesTracesInParallel(t *testing.T) {
	const other = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2"
	c := NewSpanCollector()
	api := newFakeTraceAPI(t)
	per := map[string]int{}
	api.answer = func(r *http.Request) any {
		id := r.URL.Path[strings.LastIndexByte(r.URL.Path, '/')+1:]
		per[id]++
		return []any{apiSpanJSON(map[string]any{"trace_id": id, "span_id": "c000000000000" + id[29:]})}
	}
	testFetcher().SettleWait(context.Background(), api.target(c, 5*time.Second, 0, rtTrace, other))
	if per[rtTrace] != 1 || per[other] != 1 {
		t.Fatalf("per trace calls %v", per)
	}
}

func TestRemoteFetcherTimeoutFeedsOneErrorSpan(t *testing.T) {
	c := NewSpanCollector()
	api := newFakeTraceAPI(t, "404")
	f := testFetcher()
	f.SettleWait(context.Background(), api.target(c, 20*time.Millisecond, 0))
	f.SettleWait(context.Background(), api.target(c, 20*time.Millisecond, 0))
	spans := c.SpansForThread(rtThread)
	if len(spans) != 1 || spans[0].Name() != SpanCollectionErrorName {
		t.Fatalf("spans %v", spanNames(spans))
	}
	s := spans[0]
	if s.Status().Code != codes.Error || !strings.Contains(s.Status().Description, "Timed out after 20ms") {
		t.Errorf("status %+v", s.Status())
	}
	if v, _ := spanAttr(s, "langwatch.span_collection.error"); !v.AsBool() {
		t.Error("error flag missing")
	}
	if v, _ := spanAttr(s, threadIDKey); v.AsString() != rtThread {
		t.Error("thread tag missing")
	}
}

func TestRemoteFetcherRetriesHardFailures(t *testing.T) {
	c := NewSpanCollector()
	api := newFakeTraceAPI(t, "error")
	if testFetcher().SettleWait(context.Background(), api.target(c, 50*time.Millisecond, 0)) {
		t.Fatal("must not settle")
	}
	if api.count() <= 1 {
		t.Error("failing poll not retried")
	}
	spans := c.SpansForThread(rtThread)
	if len(spans) != 1 || !strings.Contains(spans[0].Status().Description, "kept failing until") || !strings.Contains(spans[0].Status().Description, "500") {
		t.Fatalf("spans %v %+v", spanNames(spans), spans[0].Status())
	}
}

func TestRemoteFetcherSettlesAfterTransientFailure(t *testing.T) {
	c := NewSpanCollector()
	api := newFakeTraceAPI(t, "error", []any{apiSpanJSON(nil)})
	testFetcher().SettleWait(context.Background(), api.target(c, 5*time.Second, 0))
	if names := spanNames(c.SpansForThread(rtThread)); !slices.Equal(names, []string{"get_weather"}) {
		t.Fatalf("names %v", names)
	}
}

func TestRemoteFetcherDedupesAndFiltersInfrastructure(t *testing.T) {
	c := NewSpanCollector()
	c.Add(localSpan("b000000000000001", "local.copy"))
	api := newFakeTraceAPI(t, []any{
		apiSpanJSON(map[string]any{"name": "remote.copy"}),
		apiSpanJSON(map[string]any{"span_id": "b000000000000002", "name": "db.write"}),
		apiSpanJSON(map[string]any{"span_id": "b000000000000003", "name": "langwatch.scenario.run"}),
		apiSpanJSON(map[string]any{"span_id": "b000000000000004", "name": "langwatch.judge.call"}),
		apiSpanJSON(map[string]any{"span_id": "b000000000000005", "name": "langwatch.user_simulator.call"}),
	})
	testFetcher().SettleWait(context.Background(), api.target(c, 5*time.Second, 0))
	names := spanNames(c.SpansForThread(rtThread))
	slices.Sort(names)
	if !slices.Equal(names, []string{"db.write", "local.copy"}) {
		t.Fatalf("names %v", names)
	}
}

func TestRemoteFetcherClearThreadForgetsState(t *testing.T) {
	c := NewSpanCollector()
	api := newFakeTraceAPI(t, []any{apiSpanJSON(nil)})
	f := testFetcher()
	f.SettleWait(context.Background(), api.target(c, 5*time.Second, 0))
	n := api.count()
	f.ClearThread(rtThread)
	f.SettleWait(context.Background(), api.target(NewSpanCollector(), 5*time.Second, 0))
	if api.count() != n+1 {
		t.Fatalf("calls %d, want %d", api.count(), n+1)
	}
}

func TestRemoteFetcherProcessSpansAreNotEvidence(t *testing.T) {
	c := NewSpanCollector()
	startProcessSpans(c, rtTrace, "c000000000000001", "c000000000000002", "c000000000000003")
	api := newFakeTraceAPI(t, []any{
		apiSpanJSON(map[string]any{"span_id": "c000000000000002", "name": "_JudgeAgent.call", "parent_id": "c000000000000001"}),
		apiSpanJSON(map[string]any{"span_id": "c000000000000003", "name": "ai.generateText", "parent_id": "c000000000000002"}),
	})
	if testFetcher().SettleWait(context.Background(), api.target(c, 30*time.Millisecond, 0)) {
		t.Fatal("must not settle on process spans")
	}
	if reason := errorReason(t, c.SpansForThread(rtThread)); !strings.Contains(reason, "no agent spans arrived") {
		t.Errorf("reason %q", reason)
	}
}

func TestRemoteFetcherClaimedTracesReleasedOnClear(t *testing.T) {
	c := NewSpanCollector()
	startProcessSpans(c, rtTrace, "c000000000000001")
	api := newFakeTraceAPI(t, []any{apiSpanJSON(map[string]any{"span_id": "c000000000000001", "name": "_JudgeAgent.call"})})
	testFetcher().SettleWait(context.Background(), api.target(c, 30*time.Millisecond, 0))
	tid, _ := parseTraceID(rtTrace)
	sid, _ := parseSpanID("c000000000000001")
	if !c.IsProcessSpan(tid, sid) {
		t.Fatal("process span not registered")
	}
	c.ClearThread(rtThread)
	if c.IsProcessSpan(tid, sid) {
		t.Error("claimed trace not released")
	}
}

func TestRemoteFetcherExtendSettleRetractsErrorSpan(t *testing.T) {
	c := NewSpanCollector()
	childOnly := []any{apiSpanJSON(map[string]any{"span_id": "b000000000000002", "name": "db.write", "parent_id": "b000000000000001"})}
	complete := []any{apiSpanJSON(map[string]any{"name": "agent.root"}), childOnly[0]}
	api := newFakeTraceAPI(t)
	var completeNow bool
	api.answer = func(*http.Request) any {
		if completeNow {
			return complete
		}
		return childOnly
	}
	f := testFetcher()
	if f.SettleWait(context.Background(), api.target(c, 10*time.Millisecond, 0)) {
		t.Fatal("first wait must fail")
	}
	api.mu.Lock()
	completeNow = true
	api.mu.Unlock()
	if !slices.Contains(spanNames(c.SpansForThread(rtThread)), SpanCollectionErrorName) {
		t.Fatal("no error span after the first wait")
	}
	f.ExtendSettle(context.Background(), api.target(c, 5*time.Second, 0))
	names := spanNames(c.SpansForThread(rtThread))
	if slices.Contains(names, SpanCollectionErrorName) || !slices.Contains(names, "agent.root") {
		t.Fatalf("names %v", names)
	}
	if f.NoneSettled(rtThread, []string{rtTrace}) {
		t.Error("trace must count as settled")
	}
}

func TestRemoteFetcherMissingCredentialsFailsAtOnce(t *testing.T) {
	t.Setenv("LANGWATCH_API_KEY", "")
	c := NewSpanCollector()
	api := newFakeTraceAPI(t, []any{apiSpanJSON(nil)})
	target := api.target(c, time.Minute, 0)
	target.LangWatch.APIKey = ""
	if testFetcher().SettleWait(context.Background(), target) || api.count() != 0 {
		t.Fatal("must fail without polling")
	}
	if reason := errorReason(t, c.SpansForThread(rtThread)); !strings.Contains(reason, "API key is not configured") {
		t.Errorf("reason %q", reason)
	}
}

func TestMessageTraceIDs(t *testing.T) {
	msgs := []Message{
		{Role: RoleUser, Content: "a"},
		{Role: RoleAssistant, TraceID: "t-1"},
		{Role: RoleUser, TraceID: "t-2"},
		{Role: RoleAssistant, TraceID: "t-1"},
		{Role: RoleAssistant, TraceID: "t-3"},
		{Role: RoleAssistant, TraceID: invalidTraceID},
	}
	if got := MessageTraceIDs(msgs); !slices.Equal(got, []string{"t-1", "t-2", "t-3"}) {
		t.Fatalf("ids %v", got)
	}
}

func decodeAPISpan(t *testing.T, overrides map[string]any) sdktrace.ReadOnlySpan {
	t.Helper()
	raw, _ := json.Marshal(apiSpanJSON(overrides))
	var s langWatchAPISpan
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	tid, _ := parseTraceID(s.TraceID)
	sid, _ := parseSpanID(s.SpanID)
	return s.readOnlySpan(tid, sid, "")
}

func TestAPISpanTimestamps(t *testing.T) {
	s := decodeAPISpan(t, map[string]any{"timestamps": map[string]any{"started_at": 1_700_000_000_123, "finished_at": 1_700_000_001_500}})
	if s.StartTime() != time.Unix(1_700_000_000, 123_000_000) || s.EndTime() != time.Unix(1_700_000_001, 500_000_000) {
		t.Fatalf("times %v %v", s.StartTime(), s.EndTime())
	}
	if d := s.EndTime().Sub(s.StartTime()); d != 1377*time.Millisecond {
		t.Errorf("duration %v", d)
	}
}

func TestAPISpanContexts(t *testing.T) {
	s := decodeAPISpan(t, map[string]any{"parent_id": "b0000000000000ff"})
	if s.SpanContext().TraceID().String() != rtTrace || s.SpanContext().SpanID().String() != "b000000000000001" {
		t.Errorf("context %v", s.SpanContext())
	}
	if s.Parent().SpanID().String() != "b0000000000000ff" {
		t.Errorf("parent %v", s.Parent())
	}
}

func TestAPISpanPayloadAttributes(t *testing.T) {
	s := decodeAPISpan(t, map[string]any{
		"input":  map[string]any{"type": "json", "value": json.RawMessage(`{"table":"orders","id":7}`)},
		"output": map[string]any{"type": "text", "value": "written"},
	})
	if v, _ := spanAttr(s, "langwatch.input"); v.AsString() != `{"table":"orders","id":7}` {
		t.Errorf("input %q", v.AsString())
	}
	if v, _ := spanAttr(s, "langwatch.output"); v.AsString() != "written" {
		t.Errorf("output %q", v.AsString())
	}
}

func TestAPISpanChatMessages(t *testing.T) {
	s := decodeAPISpan(t, map[string]any{
		"type": "llm", "model": "openai/gpt-5-mini",
		"input": map[string]any{"type": "chat_messages", "value": []any{map[string]any{"role": "user", "content": "hi"}}},
	})
	if v, _ := spanAttr(s, "langwatch.span.type"); v.AsString() != "llm" {
		t.Errorf("type %q", v.AsString())
	}
	if v, _ := spanAttr(s, "gen_ai.request.model"); v.AsString() != "openai/gpt-5-mini" {
		t.Errorf("model %q", v.AsString())
	}
	if v, _ := spanAttr(s, "gen_ai.input.messages"); v.AsString() != `[{"content":"hi","role":"user"}]` {
		t.Errorf("messages %q", v.AsString())
	}
}

func TestAPISpanParamsAndMetrics(t *testing.T) {
	s := decodeAPISpan(t, map[string]any{
		"params":   json.RawMessage(`{"temperature":0.2,"_keys":["x"],"nested":{"a":1,"b":null,"list":[1,2]}}`),
		"metrics":  map[string]any{"prompt_tokens": 10, "completion_tokens": 5, "cost": 0.01},
		"contexts": []any{"doc"},
	})
	for key, want := range map[string]string{
		"gen_ai.request.temperature":     "0.2",
		"temperature":                    "0.2",
		"nested.a":                       "1",
		"nested.list":                    "[1,2]",
		"gen_ai.usage.prompt_tokens":     "10",
		"gen_ai.usage.completion_tokens": "5",
		"retrieval.documents":            `["doc"]`,
	} {
		v, ok := spanAttr(s, key)
		if !ok || v.Emit() != want {
			t.Errorf("%s = %q (present %v), want %q", key, v.Emit(), ok, want)
		}
	}
	for _, key := range []string{"_keys", "nested.b"} {
		if _, ok := spanAttr(s, key); ok {
			t.Errorf("%s must be skipped", key)
		}
	}
}

func TestAPISpanError(t *testing.T) {
	s := decodeAPISpan(t, map[string]any{"error": map[string]any{"has_error": true, "message": "tool exploded", "stacktrace": []any{}}})
	if s.Status().Code != codes.Error || s.Status().Description != "tool exploded" {
		t.Fatalf("status %+v", s.Status())
	}
}

func BenchmarkRemoteFetcherMerge(b *testing.B) {
	spans := make([]langWatchAPISpan, 200)
	for i := range spans {
		raw, _ := json.Marshal(apiSpanJSON(map[string]any{
			"span_id":   fmt.Sprintf("%016x", i+1),
			"parent_id": fmt.Sprintf("%016x", max(i, 1)),
			"input":     map[string]any{"type": "json", "value": map[string]any{"q": "select * from orders", "i": i}},
		}))
		_ = json.Unmarshal(raw, &spans[i])
	}
	f := testFetcher()
	target := TraceSettleTarget{ThreadID: rtThread, TraceIDs: []string{rtTrace}}
	b.ReportAllocs()
	for b.Loop() {
		target.Collector = NewSpanCollector()
		st := &traceFetchState{merged: map[trace.SpanID]struct{}{}}
		f.merge(target, st, spans)
	}
}
