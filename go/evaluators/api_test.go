package evaluators

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

type recorded struct {
	method, path string
	headers      http.Header
	body         string
}

// fakeEvaluationsAPI answers each path with its JSON body, 404 otherwise.
func fakeEvaluationsAPI(t *testing.T, bodies map[string]any) (*httptest.Server, func() []recorded) {
	t.Helper()
	var mu sync.Mutex
	var calls []recorded
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		calls = append(calls, recorded{r.Method, r.URL.EscapedPath(), r.Header.Clone(), string(body)})
		mu.Unlock()
		b, ok := bodies[r.URL.EscapedPath()]
		if !ok {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if s, ok := b.(int); ok {
			http.Error(w, "boom", s)
			return
		}
		_ = json.NewEncoder(w).Encode(b)
	}))
	t.Cleanup(srv.Close)
	return srv, func() []recorded {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(calls)
	}
}

func client(srv *httptest.Server) *Client {
	return NewClient(scenario.LangWatchConfig{Endpoint: srv.URL, APIKey: "sk-test"}, ClientOptions{})
}

var exactMatchCatalogue = map[string]any{"evaluators": map[string]any{
	"langevals/exact_match": map[string]any{
		"name": "Exact Match", "requiredFields": []string{"output", "expected_output"}, "optionalFields": []string{},
		"result": map[string]any{"passed": map[string]any{}},
	},
}}

func TestClientSavedEvaluatorFields(t *testing.T) {
	srv, _ := fakeEvaluationsAPI(t, map[string]any{"/api/evaluators/answer-check": map[string]any{
		"id": "eval_1", "name": "Answer check", "config": map[string]any{"evaluatorType": "custom/code"},
		"fields": []any{
			map[string]any{"identifier": "output", "type": "str"},
			map[string]any{"identifier": "contexts", "type": "list", "optional": true},
		},
		"outputFields": []any{map[string]any{"identifier": "passed", "type": "bool"}},
	}})
	spec, err := client(srv).EvaluatorSpec(context.Background(), "evaluators/answer-check")
	if err != nil {
		t.Fatal(err)
	}
	want := &EvaluatorSpec{EvaluatorID: "eval_1", Name: "Answer check", Inputs: []Input{{"output", true}, {"contexts", false}}, ProducesPassed: true}
	if spec.EvaluatorID != want.EvaluatorID || spec.Name != want.Name || !slices.Equal(spec.Inputs, want.Inputs) || !spec.ProducesPassed {
		t.Errorf("spec %+v", spec)
	}
}

func TestClientScoreOnlySavedEvaluator(t *testing.T) {
	srv, _ := fakeEvaluationsAPI(t, map[string]any{"/api/evaluators/quality": map[string]any{
		"id": "eval_2", "name": "Quality",
		"fields":       []any{map[string]any{"identifier": "output"}},
		"outputFields": []any{map[string]any{"identifier": "score"}},
	}})
	spec, err := client(srv).EvaluatorSpec(context.Background(), "evaluators/quality")
	if err != nil || spec.ProducesPassed {
		t.Fatalf("spec %+v err %v", spec, err)
	}
}

func TestClientSavedEvaluatorFallsBackToCatalogue(t *testing.T) {
	for name, fieldsJSON := range map[string]any{
		"fields without identifier": []any{map[string]any{}, map[string]any{"identifier": ""}},
		"no fields":                 []any{},
	} {
		srv, _ := fakeEvaluationsAPI(t, map[string]any{
			"/api/evaluators/exact": map[string]any{"id": "eval_3", "name": "Exact", "config": map[string]any{"evaluatorType": "langevals/exact_match"}, "fields": fieldsJSON},
			"/api/evaluations/list": exactMatchCatalogue,
		})
		spec, err := client(srv).EvaluatorSpec(context.Background(), "evaluators/exact")
		if err != nil {
			t.Fatal(err)
		}
		if ids := []string{spec.Inputs[0].ID, spec.Inputs[1].ID}; !slices.Equal(ids, []string{"output", "expected_output"}) || spec.Name != "Exact" || spec.EvaluatorID != "eval_3" {
			t.Errorf("%s: spec %+v", name, spec)
		}
	}
}

func TestClientCatalogueTypeAndUnknown(t *testing.T) {
	srv, calls := fakeEvaluationsAPI(t, map[string]any{"/api/evaluations/list": exactMatchCatalogue})
	c := client(srv)
	spec, err := c.EvaluatorSpec(context.Background(), "langevals/exact_match")
	if err != nil || spec.Name != "Exact Match" || !spec.ProducesPassed || len(spec.Inputs) != 2 {
		t.Fatalf("spec %+v err %v", spec, err)
	}
	if spec, err := c.EvaluatorSpec(context.Background(), "langevals/nope"); spec != nil || err != nil {
		t.Errorf("unknown: %+v %v", spec, err)
	}
	if spec, err := c.EvaluatorSpec(context.Background(), "evaluators/missing"); spec != nil || err != nil {
		t.Errorf("unknown saved: %+v %v", spec, err)
	}
	n := 0
	for _, call := range calls() {
		if call.path == "/api/evaluations/list" {
			n++
		}
	}
	if n != 1 {
		t.Errorf("catalogue loaded %d times", n)
	}
}

func TestClientEvaluateRequest(t *testing.T) {
	srv, calls := fakeEvaluationsAPI(t, map[string]any{
		"/api/evaluations/langevals/exact_match/evaluate": map[string]any{"status": "processed", "passed": true, "cost": map[string]any{"currency": "USD", "amount": 0.01}},
	})
	c := NewClient(scenario.LangWatchConfig{Endpoint: srv.URL, APIKey: "sk-test", ProjectID: "proj"}, ClientOptions{})
	resp, err := c.Evaluate(context.Background(), EvaluateRequest{
		EvaluatorRef: "langevals/exact_match", Data: map[string]any{"output": "x"}, Settings: map[string]any{"case": false},
	})
	if err != nil || resp.Status != "processed" || resp.Passed == nil || !*resp.Passed || resp.Cost.Amount != 0.01 {
		t.Fatalf("resp %+v err %v", resp, err)
	}
	call := calls()[0]
	if call.method != http.MethodPost || call.body != `{"data":{"output":"x"},"settings":{"case":false},"trace_id":null}` {
		t.Errorf("request %s %s", call.method, call.body)
	}
	h := call.headers
	if h.Get("Authorization") != "Bearer sk-test" || h.Get("X-Auth-Token") != "sk-test" || h.Get("X-Project-Id") != "proj" || h.Get("Content-Type") != "application/json" {
		t.Errorf("headers %v", h)
	}
}

func TestClientEvaluateHTTPError(t *testing.T) {
	srv, _ := fakeEvaluationsAPI(t, map[string]any{"/api/evaluations/langevals/exact_match/evaluate": 500})
	_, err := client(srv).Evaluate(context.Background(), EvaluateRequest{EvaluatorRef: "langevals/exact_match"})
	var apiErr *APIError
	if !errors.As(err, &apiErr) || !strings.HasPrefix(err.Error(), "Evaluation API answered 500: boom") {
		t.Fatalf("err %v", err)
	}
}

func TestClientRefusesRedirects(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("redirect followed with key %q", r.Header.Get("Authorization"))
	}))
	defer target.Close()
	srv := httptest.NewServer(http.RedirectHandler(target.URL+"/steal", http.StatusFound))
	defer srv.Close()
	c := client(srv)
	if _, err := c.EvaluatorSpec(context.Background(), "langevals/exact_match"); err == nil {
		t.Error("catalogue redirect must fail")
	}
	if _, err := c.Evaluate(context.Background(), EvaluateRequest{EvaluatorRef: "langevals/exact_match"}); err == nil {
		t.Error("evaluate redirect must fail")
	}
}

func TestClientTimesOut(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer srv.Close()
	defer close(release)
	c := NewClient(scenario.LangWatchConfig{Endpoint: srv.URL, APIKey: "k"}, ClientOptions{Timeout: 20e6})
	if _, err := c.Evaluate(context.Background(), EvaluateRequest{EvaluatorRef: "x/y"}); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("err %v", err)
	}
}

func TestRequestBodyEncodesStateValues(t *testing.T) {
	body := requestBody(EvaluateRequest{
		Data: map[string]any{
			"messages": []scenario.Message{scenario.UserMsg("hi")},
			"n":        3,
			"z":        "last",
		},
		Order: []string{"messages"},
	})
	if want := `{"data":{"messages":[{"role":"user","content":"hi"}],"n":3,"z":"last"},"trace_id":null}`; !bytes.Equal(body, []byte(want)) {
		t.Errorf("body %s", body)
	}
}
