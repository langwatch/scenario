package openairealtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/langwatch/scenario/go/voice/internal/realtimetest"
)

// How the adapter obtains the credential it dials with: a gateway mint
// (usage reported, ephemeral secret on the socket), a vendor mint (no
// session to report to), an absent route (direct dial, with a warning) and
// a refusal (nothing dialled).

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// gatewayStub records the HTTP calls the adapter made and answers them.
type gatewayStub struct {
	mu     sync.Mutex
	urls   []string
	bodies []any
	answer func(url string) *http.Response
}

func (g *gatewayStub) client() *http.Client {
	return &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		var body any
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		g.mu.Lock()
		g.urls = append(g.urls, r.URL.String())
		g.bodies = append(g.bodies, body)
		g.mu.Unlock()
		return g.answer(r.URL.String()), nil
	})}
}

func (g *gatewayStub) calls() ([]string, []any) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]string(nil), g.urls...), append([]any(nil), g.bodies...)
}

func mintResponse(status int, sessionID string) *http.Response {
	h := http.Header{}
	body := "no"
	if status == 200 {
		body = `{"value":"ek_minted_secret"}`
		if sessionID != "" {
			h.Set("X-LangWatch-Session-Id", sessionID)
		}
	}
	return &http.Response{StatusCode: status, Header: h, Body: io.NopCloser(strings.NewReader(body))}
}

func accepted() *http.Response {
	return &http.Response{StatusCode: 202, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("{}"))}
}

// mintAdapter builds an adapter that mints through stub and records the
// auth header its socket dialled with.
func mintAdapter(srv *realtimetest.Server, stub *gatewayStub, dialled *[]string, logger *slog.Logger) *Adapter {
	if logger == nil {
		logger = quiet
	}
	return New(Options{
		URL:        srv.URL + "/realtime",
		HTTPClient: stub.client(),
		Logger:     logger,
		Dial: func(ctx context.Context, url string, h http.Header) (*websocket.Conn, error) {
			*dialled = append(*dialled, h.Get("Authorization"))
			c, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: h})
			return c, err
		},
	})
}

func setEnv(t *testing.T, kv ...string) {
	for _, k := range []string{"OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_REALTIME_API_KEY", "OPENAI_REALTIME_URL"} {
		t.Setenv(k, "")
	}
	for i := 0; i+1 < len(kv); i += 2 {
		t.Setenv(kv[i], kv[i+1])
	}
}

func TestGatewayMintDialsWithTheEphemeralSecretAndReports(t *testing.T) {
	setEnv(t, "OPENAI_BASE_URL", "https://gateway.example/v1", "OPENAI_API_KEY", "vk-lw-test",
		"OPENAI_REALTIME_API_KEY", "sk-direct-provider-key")
	srv := realtimetest.New(t)
	stub := &gatewayStub{answer: func(u string) *http.Response {
		if strings.HasSuffix(u, "/client_secrets") {
			return mintResponse(200, "req_abc")
		}
		return accepted()
	}}
	var dialled []string
	a := mintAdapter(srv, stub, &dialled, nil)
	ctx := context.Background()
	if err := a.Realtime().Connect(ctx); err != nil {
		t.Fatal(err)
	}
	if !a.Realtime().Brokered() {
		t.Fatal("not brokered")
	}
	_ = a.Realtime().Disconnect(ctx)
	urls, _ := stub.calls()
	want := []string{"https://gateway.example/v1/realtime/client_secrets", "https://gateway.example/v1/realtime/sessions/req_abc/usage"}
	if !reflect.DeepEqual(urls, want) {
		t.Fatalf("calls = %v", urls)
	}
	if !reflect.DeepEqual(dialled, []string{"Bearer ek_minted_secret"}) {
		t.Fatalf("dialled = %v", dialled)
	}
}

func TestVendorMintReportsNoSession(t *testing.T) {
	setEnv(t, "OPENAI_API_KEY", "sk-provider")
	srv := realtimetest.New(t)
	stub := &gatewayStub{answer: func(string) *http.Response { return mintResponse(200, "") }}
	var dialled []string
	a := mintAdapter(srv, stub, &dialled, nil)
	ctx := context.Background()
	if err := a.Realtime().Connect(ctx); err != nil {
		t.Fatal(err)
	}
	_ = a.Realtime().Disconnect(ctx)
	urls, _ := stub.calls()
	if !reflect.DeepEqual(urls, []string{"https://api.openai.com/v1/realtime/client_secrets"}) {
		t.Fatalf("calls = %v", urls)
	}
	if !reflect.DeepEqual(dialled, []string{"Bearer ek_minted_secret"}) || a.Realtime().Brokered() {
		t.Fatalf("dialled = %v brokered = %v", dialled, a.Realtime().Brokered())
	}
}

func TestAbsentMintRouteDialsDirectlyAndWarns(t *testing.T) {
	setEnv(t, "OPENAI_BASE_URL", "https://old-gateway.example/v1", "OPENAI_API_KEY", "vk-lw-test",
		"OPENAI_REALTIME_API_KEY", "sk-direct-provider-key")
	srv := realtimetest.New(t)
	stub := &gatewayStub{answer: func(string) *http.Response { return mintResponse(404, "") }}
	var dialled []string
	var logs bytes.Buffer
	a := mintAdapter(srv, stub, &dialled, slog.New(slog.NewTextHandler(&logs, nil)))
	ctx := context.Background()
	if err := a.Realtime().Connect(ctx); err != nil {
		t.Fatal(err)
	}
	_ = a.Realtime().Disconnect(ctx)
	if !reflect.DeepEqual(dialled, []string{"Bearer sk-direct-provider-key"}) || a.Realtime().Brokered() {
		t.Fatalf("dialled = %v", dialled)
	}
	for _, want := range []string{"old-gateway.example", "OPENAI_REALTIME_API_KEY", "not billed"} {
		if !strings.Contains(logs.String(), want) {
			t.Errorf("warning lacks %q: %s", want, logs.String())
		}
	}
}

func TestSocketThatNeverOpensClosesTheSessionAtZero(t *testing.T) {
	setEnv(t, "OPENAI_BASE_URL", "https://gateway.example/v1", "OPENAI_API_KEY", "vk-lw-test")
	stub := &gatewayStub{answer: func(u string) *http.Response {
		if strings.HasSuffix(u, "/client_secrets") {
			return mintResponse(200, "req_abc")
		}
		return accepted()
	}}
	a := New(Options{URL: "ws://127.0.0.1:1/realtime", HTTPClient: stub.client(), Logger: quiet,
		Dial: func(context.Context, string, http.Header) (*websocket.Conn, error) {
			return nil, errors.New("connection refused")
		}})
	if err := a.Realtime().Connect(context.Background()); err == nil {
		t.Fatal("connect succeeded")
	}
	urls, bodies := stub.calls()
	want := []string{"https://gateway.example/v1/realtime/client_secrets", "https://gateway.example/v1/realtime/sessions/req_abc/usage"}
	if !reflect.DeepEqual(urls, want) {
		t.Fatalf("calls = %v", urls)
	}
	if !reflect.DeepEqual(bodies[1], map[string]any{"usage": map[string]any{"input_tokens": 0.0, "output_tokens": 0.0}}) {
		t.Fatalf("report = %v", bodies[1])
	}
}

func TestRefusedMintOpensNoSocket(t *testing.T) {
	setEnv(t, "OPENAI_BASE_URL", "https://gateway.example/v1", "OPENAI_API_KEY", "vk-lw-test",
		"OPENAI_REALTIME_API_KEY", "sk-direct-provider-key")
	srv := realtimetest.New(t)
	stub := &gatewayStub{answer: func(string) *http.Response { return mintResponse(402, "") }}
	var dialled []string
	a := mintAdapter(srv, stub, &dialled, nil)
	err := a.Realtime().Connect(context.Background())
	if err == nil || !strings.Contains(err.Error(), "refused with HTTP 402") {
		t.Fatalf("err = %v", err)
	}
	if len(dialled) != 0 {
		t.Fatalf("dialled = %v", dialled)
	}
}

func TestNoKeyAtAllFailsWithTheAdaptersMessage(t *testing.T) {
	setEnv(t)
	err := New(Options{NoMint: true}).Realtime().Connect(context.Background())
	if err == nil || !strings.Contains(err.Error(), "OpenAIRealtimeAgentAdapter: no API key") {
		t.Fatalf("err = %v", err)
	}
}

// What a brokered session reports when it ends: the sum of every
// response.done, zero for a session that produced none, and only once.
func brokeredSession(t *testing.T) (*realtimetest.Server, *Adapter, func() []any) {
	setEnv(t, "OPENAI_BASE_URL", "https://gateway.example/v1", "OPENAI_API_KEY", "vk-lw-test")
	srv := realtimetest.New(t)
	stub := &gatewayStub{answer: func(u string) *http.Response {
		if strings.HasSuffix(u, "/client_secrets") {
			return mintResponse(200, "req_abc")
		}
		return accepted()
	}}
	var dialled []string
	a := mintAdapter(srv, stub, &dialled, nil)
	srv.Arm()
	if err := a.Realtime().Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	srv.WaitConnected(t)
	reports := func() []any {
		urls, bodies := stub.calls()
		var out []any
		for i, u := range urls {
			if strings.HasSuffix(u, "/usage") {
				out = append(out, bodies[i])
			}
		}
		return out
	}
	return srv, a, reports
}

func TestBrokeredSessionReportsEveryTurn(t *testing.T) {
	srv, a, reports := brokeredSession(t)
	for _, in := range []float64{120, 135} {
		srv.Push(t, map[string]any{"type": "response.done", "response": map[string]any{"usage": map[string]any{
			"input_tokens": in, "output_tokens": 4, "total_tokens": in + 4,
			"output_token_details": map[string]any{"audio_tokens": 3},
		}}})
	}
	time.Sleep(50 * time.Millisecond)
	_ = a.Realtime().Disconnect(context.Background())
	want := []any{map[string]any{"usage": map[string]any{
		"input_tokens": 255.0, "output_tokens": 8.0, "total_tokens": 263.0,
		"output_token_details": map[string]any{"audio_tokens": 6.0},
	}}}
	if got := reports(); !reflect.DeepEqual(got, want) {
		t.Fatalf("reports = %v", got)
	}
}

func TestBrokeredSessionWithNoResponseClosesAtZero(t *testing.T) {
	_, a, reports := brokeredSession(t)
	_ = a.Realtime().Disconnect(context.Background())
	want := []any{map[string]any{"usage": map[string]any{"input_tokens": 0.0, "output_tokens": 0.0}}}
	if got := reports(); !reflect.DeepEqual(got, want) {
		t.Fatalf("reports = %v", got)
	}
}

func TestBrokeredSessionReportsOnce(t *testing.T) {
	_, a, reports := brokeredSession(t)
	ctx := context.Background()
	_ = a.Realtime().Disconnect(ctx)
	_ = a.Realtime().Disconnect(ctx)
	if got := reports(); len(got) != 1 {
		t.Fatalf("reports = %v", got)
	}
}
