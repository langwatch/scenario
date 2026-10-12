// Package broker mints realtime voice sessions, at OpenAI or at a LangWatch
// AI Gateway in front of it, and reports what a session used.
//
// POST /v1/realtime/client_secrets is OpenAI's own path. A gateway mirrors
// it: it checks the virtual key's budget and open-session cap, mints
// OpenAI's ephemeral client secret and opens one spend record for the call.
// The media socket still runs client to vendor either way, so latency and
// the wire protocol are unchanged.
//
// That symmetry is the design. The adapter reads OPENAI_BASE_URL and
// OPENAI_API_KEY, the two variables scenario already reads for chat, and
// mints at ${OPENAI_BASE_URL}/realtime/client_secrets. Point them at OpenAI
// and the mint happens there with a provider key; point them at a gateway
// and it happens through the broker with a virtual key.
package broker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// DefaultBaseURL is the vendor's base URL, used when OPENAI_BASE_URL is
// unset.
const DefaultBaseURL = "https://api.openai.com/v1"

// SessionIDHeader names the session a gateway opened. OpenAI does not set it.
const SessionIDHeader = "X-LangWatch-Session-Id"

const mintPath = "/realtime/client_secrets"

// DefaultMintTimeout bounds a mint. Connect waits for it before it opens the
// socket, so an unbounded request would leave connection setup pending
// forever against a stalled endpoint.
const DefaultMintTimeout = 15 * time.Second

// DefaultReportTimeout bounds a usage report. Disconnect waits for it; a
// report is worth a few seconds and never worth a hang, since the session
// settles on the gateway's own grace if it never arrives.
const DefaultReportTimeout = 5 * time.Second

// maxRefusalBody caps how much of a refusal body is quoted.
const maxRefusalBody = 500

// Endpoint is where a mint goes and the key it carries.
type Endpoint struct {
	// BaseURL is the OpenAI-compatible base URL, including /v1, without a
	// trailing slash.
	BaseURL string
	// APIKey is what the endpoint authenticates: a provider key, or a
	// virtual key.
	APIKey string
}

// ResolveEndpoint resolves where to mint: the explicit fields, else
// OPENAI_API_KEY and OPENAI_BASE_URL (default [DefaultBaseURL]). It returns
// nil when there is no key to mint with.
//
// OPENAI_REALTIME_API_KEY is deliberately not consulted. It holds a direct
// provider key for the socket, and presenting it to a gateway would offer a
// credential the gateway did not issue and cannot bill.
func ResolveEndpoint(explicit *Endpoint) *Endpoint {
	var ep Endpoint
	if explicit != nil {
		ep = *explicit
	}
	if ep.APIKey == "" {
		ep.APIKey = os.Getenv("OPENAI_API_KEY")
	}
	if ep.APIKey == "" {
		return nil
	}
	if ep.BaseURL == "" {
		ep.BaseURL = os.Getenv("OPENAI_BASE_URL")
	}
	if ep.BaseURL == "" {
		ep.BaseURL = DefaultBaseURL
	}
	ep.BaseURL = strings.TrimRight(ep.BaseURL, "/")
	return &ep
}

// Params configure a mint.
type Params struct {
	// Model is the realtime model the session is minted for.
	Model string
	// ExpiresAfter, when set, asks for a secret expiring this long after
	// creation.
	ExpiresAfter time.Duration
	// HTTPClient defaults to http.DefaultClient.
	HTTPClient *http.Client
	// Timeout defaults to DefaultMintTimeout.
	Timeout time.Duration
	// Logger receives the direct-dial warning; defaults to slog.Default().
	Logger *slog.Logger
}

// MintResult is what a mint attempt produced.
type MintResult struct {
	// Minted is false when the endpoint has no mint route (HTTP 404).
	Minted bool
	// ClientSecret is the ephemeral credential the socket dials with.
	ClientSecret string
	// SessionID is the gateway's id for the session; empty when the vendor
	// minted the credential itself, so there is no session to report to.
	SessionID string
	// Status is the HTTP status of a mint that did not happen.
	Status int
}

// Mint mints a realtime session and reports whether the route existed.
//
// A 404 means the base URL points at something with no mint route (a
// gateway older than this feature): an absence, so the caller may dial the
// vendor directly. Any other error status is a refusal by an endpoint that
// has the route, such as an exhausted budget or a rejected model, and it
// fails: falling back would spend a direct provider key on a call the
// gateway just declined to bill.
func Mint(ctx context.Context, ep Endpoint, p Params) (MintResult, error) {
	body := map[string]any{"session": map[string]any{"type": "realtime", "model": p.Model}}
	if p.ExpiresAfter > 0 {
		body["expires_after"] = map[string]any{"anchor": "created_at", "seconds": int64(p.ExpiresAfter / time.Second)}
	}
	ctx, cancel := context.WithTimeout(ctx, orDefault(p.Timeout, DefaultMintTimeout))
	defer cancel()
	status, header, text, err := post(ctx, p.HTTPClient, ep.BaseURL+mintPath, ep.APIKey, body)
	if err != nil {
		return MintResult{}, fmt.Errorf("realtime mint at %s failed: %w", ep.BaseURL, err)
	}
	if status == http.StatusNotFound {
		return MintResult{Status: status}, nil
	}
	if status < 200 || status > 299 {
		// The endpoint's own message names the budget, the session cap or the
		// missing provider far more precisely than a status.
		return MintResult{}, fmt.Errorf("realtime mint refused with HTTP %d: the gateway at %s refused the mint, "+
			"so this session must not fall back to a direct provider key. %s", status, ep.BaseURL, truncate(text, maxRefusalBody))
	}
	var parsed map[string]any
	if err := json.Unmarshal(text, &parsed); err != nil {
		return MintResult{}, errors.New("realtime mint returned a body that is not JSON")
	}
	secret := readClientSecret(parsed)
	if secret == "" {
		return MintResult{}, errors.New("realtime mint returned no client secret")
	}
	return MintResult{Minted: true, ClientSecret: secret, SessionID: header.Get(SessionIDHeader)}, nil
}

// readClientSecret reads the credential wherever the mint put it: OpenAI
// returns {value} today and has nested it under client_secret before.
func readClientSecret(body map[string]any) string {
	if v, ok := body["value"].(string); ok && v != "" {
		return v
	}
	if nested, ok := body["client_secret"].(map[string]any); ok {
		if v, ok := nested["value"].(string); ok {
			return v
		}
	}
	return ""
}

// Fallback is a long-lived key for dialing the vendor directly, and the
// variable it came from (named in the direct-dial warning).
type Fallback struct {
	APIKey string
	Source string
}

// SocketCredential is the bearer a media socket opens with and the session
// it belongs to.
type SocketCredential struct {
	// SocketKey is an ephemeral secret when a mint answered, a long-lived
	// key otherwise.
	SocketKey string
	// SessionID is the gateway's id for the session; empty unless a gateway
	// minted it.
	SessionID string
	// Minted reports whether a mint answered at all.
	Minted bool
}

// AcquireSocketKey decides what a realtime socket dials with, the one
// implementation of that rule:
//
//   - a mint answered, so the socket carries an ephemeral secret;
//   - the mint route was absent (HTTP 404), so the vendor is dialed directly
//     with the fallback key, with a warning;
//   - the mint was refused (any other error status), so it fails and no
//     socket opens.
//
// With no endpoint the fallback key is used without a mint attempt;
// noCredential is the error message when nothing is left to dial with.
func AcquireSocketKey(ctx context.Context, ep *Endpoint, fb Fallback, p Params, noCredential string) (SocketCredential, error) {
	if ep != nil {
		res, err := Mint(ctx, *ep, p)
		if err != nil {
			return SocketCredential{}, err
		}
		if res.Minted {
			return SocketCredential{SocketKey: res.ClientSecret, SessionID: res.SessionID, Minted: true}, nil
		}
		WarnDirectDialFallback(p.Logger, ep.BaseURL, fb.Source)
	}
	if fb.APIKey == "" {
		return SocketCredential{}, errors.New(noCredential)
	}
	return SocketCredential{SocketKey: fb.APIKey}, nil
}

// WarnDirectDialFallback warns that a mint route was absent and a direct
// provider key is in use. Loud on purpose: a silent fallback looks exactly
// like a brokered run while producing no spend record at all.
func WarnDirectDialFallback(logger *slog.Logger, baseURL, credentialSource string) {
	if logger == nil {
		logger = slog.Default()
	}
	logger.Warn(fmt.Sprintf("realtime mint route not found at %s%s; dialing the vendor directly with %s. "+
		"This session is not billed or budgeted by the gateway at %s.", baseURL, mintPath, credentialSource, baseURL))
}

// ReportParams configure a usage report.
type ReportParams struct {
	// HTTPClient defaults to http.DefaultClient.
	HTTPClient *http.Client
	// Timeout defaults to DefaultReportTimeout.
	Timeout time.Duration
	// OnError receives a failed or refused report.
	OnError func(error)
}

// ReportUsage reports what the socket measured, closing the session's spend
// record. OpenAI reports usage over the socket, which runs client to vendor,
// so this is the only path by which those numbers reach a gateway.
//
// It never fails: a failed report costs accuracy on one session, and must
// not fail a test whose subject is the agent. Failures and refusals go to
// OnError. An empty sessionID (the vendor minted) sends nothing.
func ReportUsage(ctx context.Context, ep Endpoint, sessionID string, usage Usage, p ReportParams) {
	if sessionID == "" {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, orDefault(p.Timeout, DefaultReportTimeout))
	defer cancel()
	u := ep.BaseURL + "/realtime/sessions/" + url.PathEscape(sessionID) + "/usage"
	status, _, _, err := post(ctx, p.HTTPClient, u, ep.APIKey, map[string]any{"usage": usage})
	switch {
	case err != nil:
		err = fmt.Errorf("realtime usage report failed: %w", err)
	case status < 200 || status > 299:
		// A refused report answers; reading only the thrown case would treat
		// a 404 or a 401 as a report that landed.
		err = fmt.Errorf("realtime usage report refused with HTTP %d", status)
	}
	if err != nil && p.OnError != nil {
		p.OnError(err)
	}
}

func post(ctx context.Context, client *http.Client, u, key string, body any) (int, http.Header, []byte, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return 0, nil, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(b))
	if err != nil {
		return 0, nil, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, nil, err
	}
	defer resp.Body.Close()
	text, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, nil, nil, err
	}
	return resp.StatusCode, resp.Header, text, nil
}

func truncate(b []byte, n int) string {
	if len(b) > n {
		b = b[:n]
	}
	return string(b)
}

func orDefault(d, def time.Duration) time.Duration {
	if d > 0 {
		return d
	}
	return def
}

// Usage is the token counts a realtime socket reported, in the vendor's own
// shape (decoded JSON: numbers are float64).
type Usage = map[string]any

// ZeroUsage is the usage of a session that consumed nothing. The counts are
// stated rather than left out: a gateway refuses a report carrying neither
// input_tokens nor output_tokens, which would leave the session open. A
// fresh map is returned each call.
func ZeroUsage() Usage { return Usage{"input_tokens": 0.0, "output_tokens": 0.0} }

// AccumulateUsage adds one response's usage into a session total and
// returns the new total (total is not modified).
//
// OpenAI reports usage per response, not per session, so keeping the last
// response.done bills a call for its last turn only. Every numeric leaf is
// summed and nested detail objects are summed key by key; flags are carried,
// not added. Keys are not listed, so a count the vendor adds later
// accumulates on its own.
func AccumulateUsage(total, usage Usage) Usage {
	merged := make(Usage, len(total)+len(usage))
	for k, v := range total {
		merged[k] = v
	}
	for k, v := range usage {
		if n, ok := number(v); ok {
			if math.IsInf(n, 0) || math.IsNaN(n) {
				continue
			}
			running, _ := number(merged[k])
			merged[k] = n + running
			continue
		}
		switch v := v.(type) {
		case bool:
			merged[k] = v
		case map[string]any:
			running, _ := merged[k].(map[string]any)
			merged[k] = AccumulateUsage(running, v)
		}
	}
	return merged
}

func number(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	}
	return 0, false
}
