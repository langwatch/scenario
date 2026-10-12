package broker

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

// roundTrip stubs the HTTP transport, the Go analogue of the JS fetchImpl.
type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func client(f roundTrip) *http.Client { return &http.Client{Transport: f} }

func respond(status int, body string, header ...string) *http.Response {
	h := http.Header{}
	for i := 0; i+1 < len(header); i += 2 {
		h.Set(header[i], header[i+1])
	}
	return &http.Response{StatusCode: status, Header: h, Body: io.NopCloser(strings.NewReader(body))}
}

// stall answers only when the request's context ends.
func stall(r *http.Request) (*http.Response, error) {
	<-r.Context().Done()
	return nil, r.Context().Err()
}

func clearEnv(t *testing.T) {
	for _, k := range []string{"OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_REALTIME_API_KEY"} {
		t.Setenv(k, "")
	}
}

var gateway = Endpoint{BaseURL: "https://gateway.example/v1", APIKey: "vk-lw-test"}

func TestResolveEndpoint(t *testing.T) {
	t.Run("mints at OpenAI when OPENAI_BASE_URL is unset", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("OPENAI_API_KEY", "sk-provider")
		if got := ResolveEndpoint(nil); *got != (Endpoint{BaseURL: DefaultBaseURL, APIKey: "sk-provider"}) {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("mints at a gateway with the chat key, trailing slash trimmed", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("OPENAI_BASE_URL", "https://gateway.example/v1/")
		t.Setenv("OPENAI_API_KEY", "vk-lw-test")
		if got := ResolveEndpoint(nil); *got != gateway {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("prefers an explicit endpoint over the environment", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("OPENAI_BASE_URL", "https://from-env.example/v1")
		t.Setenv("OPENAI_API_KEY", "vk-from-env")
		want := Endpoint{BaseURL: "https://explicit.example/v1", APIKey: "vk-explicit"}
		if got := ResolveEndpoint(&want); *got != want {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("does not mint with OPENAI_REALTIME_API_KEY alone", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("OPENAI_BASE_URL", "https://gateway.example/v1")
		t.Setenv("OPENAI_REALTIME_API_KEY", "sk-real-provider-key")
		if got := ResolveEndpoint(nil); got != nil {
			t.Fatalf("got %+v", got)
		}
	})
}

func TestMint(t *testing.T) {
	ctx := context.Background()
	t.Run("sends the key and reads back the secret and the session id", func(t *testing.T) {
		c := client(func(r *http.Request) (*http.Response, error) {
			if r.URL.String() != "https://gateway.example/v1/realtime/client_secrets" {
				t.Errorf("url = %s", r.URL)
			}
			if got := r.Header.Get("Authorization"); got != "Bearer vk-lw-test" {
				t.Errorf("auth = %s", got)
			}
			var body any
			_ = json.NewDecoder(r.Body).Decode(&body)
			want := map[string]any{"session": map[string]any{"type": "realtime", "model": "gpt-realtime"}}
			if !reflect.DeepEqual(body, want) {
				t.Errorf("body = %v", body)
			}
			return respond(200, `{"value":"ek_abc","expires_at":1}`, "x-langwatch-session-id", "req_123"), nil
		})
		res, err := Mint(ctx, gateway, Params{Model: "gpt-realtime", HTTPClient: c})
		if err != nil || res != (MintResult{Minted: true, ClientSecret: "ek_abc", SessionID: "req_123"}) {
			t.Fatalf("res = %+v, %v", res, err)
		}
	})
	t.Run("reports no session id when the vendor answered", func(t *testing.T) {
		c := client(func(*http.Request) (*http.Response, error) { return respond(200, `{"value":"ek_from_openai"}`), nil })
		res, err := Mint(ctx, gateway, Params{Model: "gpt-realtime", HTTPClient: c})
		if err != nil || res != (MintResult{Minted: true, ClientSecret: "ek_from_openai"}) {
			t.Fatalf("res = %+v, %v", res, err)
		}
	})
	t.Run("reads a secret nested under client_secret", func(t *testing.T) {
		c := client(func(*http.Request) (*http.Response, error) {
			return respond(200, `{"client_secret":{"value":"ek_nested"}}`), nil
		})
		res, err := Mint(ctx, gateway, Params{HTTPClient: c})
		if err != nil || res.ClientSecret != "ek_nested" {
			t.Fatalf("res = %+v, %v", res, err)
		}
	})
	t.Run("reports an absent mint route rather than failing", func(t *testing.T) {
		c := client(func(*http.Request) (*http.Response, error) { return respond(404, "not found"), nil })
		res, err := Mint(ctx, gateway, Params{HTTPClient: c})
		if err != nil || res != (MintResult{Status: 404}) {
			t.Fatalf("res = %+v, %v", res, err)
		}
	})
	t.Run("fails on a refusal, quoting the endpoint's message", func(t *testing.T) {
		c := client(func(*http.Request) (*http.Response, error) {
			return respond(429, `{"error":{"code":"realtime_session_limit","message":"this virtual key already holds the most voice sessions"}}`), nil
		})
		_, err := Mint(ctx, gateway, Params{HTTPClient: c})
		if err == nil || !strings.Contains(err.Error(), "realtime_session_limit") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("gives up on a stalled endpoint", func(t *testing.T) {
		start := time.Now()
		_, err := Mint(ctx, gateway, Params{HTTPClient: client(stall), Timeout: 20 * time.Millisecond})
		if err == nil || time.Since(start) > 5*time.Second {
			t.Fatalf("err = %v after %v", err, time.Since(start))
		}
	})
	t.Run("refuses a mint that returned no credential", func(t *testing.T) {
		c := client(func(*http.Request) (*http.Response, error) { return respond(200, `{"expires_at":1}`), nil })
		_, err := Mint(ctx, gateway, Params{HTTPClient: c})
		if err == nil || !strings.Contains(err.Error(), "no client secret") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("asks for an expiry when one is set", func(t *testing.T) {
		c := client(func(r *http.Request) (*http.Response, error) {
			b, _ := io.ReadAll(r.Body)
			if !bytes.Contains(b, []byte(`"expires_after":{"anchor":"created_at","seconds":60}`)) {
				t.Errorf("body = %s", b)
			}
			return respond(200, `{"value":"ek"}`), nil
		})
		if _, err := Mint(ctx, gateway, Params{HTTPClient: c, ExpiresAfter: time.Minute}); err != nil {
			t.Fatal(err)
		}
	})
}

func TestReportUsage(t *testing.T) {
	ctx := context.Background()
	t.Run("posts the vendor's usage against the session id", func(t *testing.T) {
		calls := 0
		c := client(func(r *http.Request) (*http.Response, error) {
			calls++
			if r.URL.String() != "https://gateway.example/v1/realtime/sessions/req_123/usage" {
				t.Errorf("url = %s", r.URL)
			}
			var body any
			_ = json.NewDecoder(r.Body).Decode(&body)
			want := map[string]any{"usage": map[string]any{"input_tokens": 15.0, "output_tokens": 43.0}}
			if !reflect.DeepEqual(body, want) {
				t.Errorf("body = %v", body)
			}
			return respond(202, "{}"), nil
		})
		ReportUsage(ctx, gateway, "req_123", Usage{"input_tokens": 15, "output_tokens": 43}, ReportParams{HTTPClient: c})
		if calls != 1 {
			t.Fatalf("calls = %d", calls)
		}
	})
	t.Run("sends nothing when the vendor minted the session", func(t *testing.T) {
		c := client(func(*http.Request) (*http.Response, error) { t.Fatal("called"); return nil, nil })
		ReportUsage(ctx, gateway, "", Usage{"input_tokens": 1}, ReportParams{HTTPClient: c})
	})
	t.Run("reports a refusal", func(t *testing.T) {
		var errs []error
		c := client(func(*http.Request) (*http.Response, error) { return respond(404, "no"), nil })
		ReportUsage(ctx, gateway, "req_123", Usage{"input_tokens": 1}, ReportParams{HTTPClient: c, OnError: func(e error) { errs = append(errs, e) }})
		if len(errs) != 1 || !strings.Contains(errs[0].Error(), "HTTP 404") {
			t.Fatalf("errs = %v", errs)
		}
	})
	t.Run("gives up on a stalled gateway", func(t *testing.T) {
		var errs []error
		ReportUsage(ctx, gateway, "req_123", Usage{"input_tokens": 1},
			ReportParams{HTTPClient: client(stall), Timeout: 20 * time.Millisecond, OnError: func(e error) { errs = append(errs, e) }})
		if len(errs) != 1 {
			t.Fatalf("errs = %v", errs)
		}
	})
	t.Run("never fails on a transport error", func(t *testing.T) {
		var errs []error
		c := client(func(*http.Request) (*http.Response, error) { return nil, io.ErrUnexpectedEOF })
		ReportUsage(ctx, gateway, "req_123", Usage{"input_tokens": 1}, ReportParams{HTTPClient: c, OnError: func(e error) { errs = append(errs, e) }})
		if len(errs) != 1 {
			t.Fatalf("errs = %v", errs)
		}
	})
}

func TestAcquireSocketKey(t *testing.T) {
	ctx := context.Background()
	ep := &Endpoint{BaseURL: "https://gateway.example/v1", APIKey: "vk-lw"}
	fb := Fallback{APIKey: "sk-direct", Source: "OPENAI_REALTIME_API_KEY"}
	const noCred = "TestAdapter: no API key."

	t.Run("carries the ephemeral secret and the session id when a gateway mints", func(t *testing.T) {
		c := client(func(*http.Request) (*http.Response, error) {
			return respond(200, `{"value":"ek_secret"}`, SessionIDHeader, "req_abc"), nil
		})
		got, err := AcquireSocketKey(ctx, ep, fb, Params{Model: "gpt-realtime", HTTPClient: c}, noCred)
		if err != nil || got != (SocketCredential{SocketKey: "ek_secret", SessionID: "req_abc", Minted: true}) {
			t.Fatalf("got %+v, %v", got, err)
		}
	})
	for _, status := range []int{401, 402, 403, 429, 500, 503} {
		t.Run("fails on HTTP "+strconv.Itoa(status), func(t *testing.T) {
			c := client(func(*http.Request) (*http.Response, error) { return respond(status, "no"), nil })
			_, err := AcquireSocketKey(ctx, ep, fb, Params{HTTPClient: c}, noCred)
			if err == nil || !strings.Contains(err.Error(), "refused with HTTP "+strconv.Itoa(status)) {
				t.Fatalf("err = %v", err)
			}
		})
	}
	t.Run("falls back on HTTP 404 and warns that the session is not billed", func(t *testing.T) {
		var logs bytes.Buffer
		c := client(func(*http.Request) (*http.Response, error) { return respond(404, "nope"), nil })
		got, err := AcquireSocketKey(ctx, ep, fb, Params{HTTPClient: c, Logger: slog.New(slog.NewTextHandler(&logs, nil))}, noCred)
		if err != nil || got != (SocketCredential{SocketKey: "sk-direct"}) {
			t.Fatalf("got %+v, %v", got, err)
		}
		if n := strings.Count(logs.String(), "level=WARN"); n != 1 || !strings.Contains(logs.String(), "not billed") {
			t.Fatalf("logs = %s", logs.String())
		}
	})
	t.Run("dials directly with no mint attempt when there is no endpoint", func(t *testing.T) {
		got, err := AcquireSocketKey(ctx, nil, fb, Params{}, noCred)
		if err != nil || got != (SocketCredential{SocketKey: "sk-direct"}) {
			t.Fatalf("got %+v, %v", got, err)
		}
	})
	t.Run("fails with the caller's message when nothing is left to dial with", func(t *testing.T) {
		_, err := AcquireSocketKey(ctx, nil, Fallback{Source: "OPENAI_API_KEY"}, Params{}, noCred)
		if err == nil || err.Error() != noCred {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestAccumulateUsage(t *testing.T) {
	t.Run("sums the turns rather than keeping the last", func(t *testing.T) {
		total := AccumulateUsage(AccumulateUsage(ZeroUsage(),
			Usage{"input_tokens": 120.0, "output_tokens": 4.0, "total_tokens": 124.0}),
			Usage{"input_tokens": 135.0, "output_tokens": 4.0, "total_tokens": 139.0})
		want := Usage{"input_tokens": 255.0, "output_tokens": 8.0, "total_tokens": 263.0}
		if !reflect.DeepEqual(total, want) {
			t.Fatalf("total = %v", total)
		}
	})
	t.Run("sums nested detail objects", func(t *testing.T) {
		first := Usage{
			"input_tokens": 10.0,
			"input_token_details": map[string]any{"text_tokens": 6.0, "audio_tokens": 4.0, "cached_tokens": 2.0,
				"cached_tokens_details": map[string]any{"audio_tokens": 1.0}},
			"output_token_details": map[string]any{"audio_tokens": 3.0},
		}
		second := Usage{
			"input_tokens": 5.0,
			"input_token_details": map[string]any{"text_tokens": 1.0, "audio_tokens": 4.0, "cached_tokens": 0.0,
				"cached_tokens_details": map[string]any{"audio_tokens": 1.0}},
			"output_token_details": map[string]any{"audio_tokens": 2.0},
		}
		want := Usage{
			"input_tokens": 15.0,
			"input_token_details": map[string]any{"text_tokens": 7.0, "audio_tokens": 8.0, "cached_tokens": 2.0,
				"cached_tokens_details": map[string]any{"audio_tokens": 2.0}},
			"output_token_details": map[string]any{"audio_tokens": 5.0},
		}
		if got := AccumulateUsage(first, second); !reflect.DeepEqual(got, want) {
			t.Fatalf("got %v", got)
		}
	})
	t.Run("accumulates a count nobody listed", func(t *testing.T) {
		got := AccumulateUsage(Usage{"input_tokens": 1.0, "reasoning_tokens": 7.0}, Usage{"input_tokens": 1.0, "reasoning_tokens": 5.0})
		if got["reasoning_tokens"] != 12.0 {
			t.Fatalf("got %v", got)
		}
	})
	t.Run("carries a flag rather than adding it", func(t *testing.T) {
		got := AccumulateUsage(Usage{"input_tokens": 1.0, "truncated": false}, Usage{"input_tokens": 1.0, "truncated": true})
		if got["truncated"] != true {
			t.Fatalf("got %v", got)
		}
	})
	t.Run("starts at stated zeros, a fresh map each call", func(t *testing.T) {
		first, second := ZeroUsage(), ZeroUsage()
		first["input_tokens"] = 99.0
		if !reflect.DeepEqual(second, Usage{"input_tokens": 0.0, "output_tokens": 0.0}) {
			t.Fatalf("second = %v", second)
		}
		b, _ := json.Marshal(ZeroUsage())
		if string(b) != `{"input_tokens":0,"output_tokens":0}` {
			t.Fatalf("json = %s", b)
		}
	})
}
