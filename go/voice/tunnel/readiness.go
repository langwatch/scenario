package tunnel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Edge readiness defaults.
const (
	DefaultReadyTimeout  = 300 * time.Second
	DefaultReadyInterval = time.Second
)

// defaultDoHEndpoints are the DNS-over-HTTPS resolvers EdgeReadiness asks
// by default: Cloudflare and Google.
var defaultDoHEndpoints = []string{
	"https://cloudflare-dns.com/dns-query",
	"https://dns.google/resolve",
}

// EdgeReadiness waits until a fresh tunnel hostname is globally resolvable.
//
// It races the DNS-over-HTTPS resolvers and the system resolver, and
// returns the instant any of them answers with an A record. It deliberately
// does not make an HTTP round trip: a fresh hostname is announced before
// DNS propagates, and this host's own egress to the tunnel edge can be
// filtered while Twilio's path to it is clean, so resolution is what proves
// Twilio will find it. Twin of the Python SDK's
// CloudflareTunnel.wait_until_edge_reachable.
type EdgeReadiness struct {
	// Host is the hostname to resolve.
	Host string
	// Timeout bounds the whole wait; default 300 s.
	Timeout time.Duration
	// Interval spaces the attempts; default 1 s.
	Interval time.Duration
	// HTTPClient sends the DoH queries; default a client with a 5 s timeout.
	HTTPClient *http.Client
	// DoHEndpoints default to Cloudflare and Google DNS-over-HTTPS.
	DoHEndpoints []string
	// LookupIP4 is the system resolver; default net.DefaultResolver.
	LookupIP4 func(ctx context.Context, host string) ([]net.IP, error)
}

// WaitUntilEdgeReachable implements Readiness. It fails with a
// *NotReadyError once the timeout elapses.
func (e EdgeReadiness) WaitUntilEdgeReachable(ctx context.Context) error {
	timeout := e.Timeout
	if timeout <= 0 {
		timeout = DefaultReadyTimeout
	}
	interval := e.Interval
	if interval <= 0 {
		interval = DefaultReadyInterval
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	last := "no resolver responded"
	for {
		err := e.resolveOnce(ctx)
		if err == nil {
			return nil
		}
		last = err.Error()
		select {
		case <-ctx.Done():
			return &NotReadyError{
				Msg: fmt.Sprintf("tunnel %s did not become globally resolvable within %v (last: %s)", e.Host, timeout, last),
				Err: ctx.Err(),
			}
		case <-time.After(interval):
		}
	}
}

// resolveOnce asks every resolver at once and succeeds on the first answer.
func (e EdgeReadiness) resolveOnce(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	endpoints := e.DoHEndpoints
	if endpoints == nil {
		endpoints = defaultDoHEndpoints
	}
	lookup := e.LookupIP4
	if lookup == nil {
		lookup = func(ctx context.Context, host string) ([]net.IP, error) {
			return net.DefaultResolver.LookupIP(ctx, "ip4", host)
		}
	}
	results := make(chan error, len(endpoints)+1)
	for _, ep := range endpoints {
		go func() { results <- e.doh(ctx, ep) }()
	}
	go func() {
		ips, err := lookup(ctx, e.Host)
		if err == nil && len(ips) == 0 {
			err = errors.New("no answer")
		}
		results <- err
	}()
	var errs []string
	for range len(endpoints) + 1 {
		err := <-results
		if err == nil {
			return nil
		}
		errs = append(errs, err.Error())
	}
	return errors.New(strings.Join(errs, ", "))
}

// doh resolves Host's A record through one DNS-over-HTTPS endpoint.
func (e EdgeReadiness) doh(ctx context.Context, endpoint string) error {
	u, err := url.Parse(endpoint)
	if err != nil {
		return err
	}
	q := u.Query()
	q.Set("name", e.Host)
	q.Set("type", "A")
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/dns-json")
	client := e.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var data struct {
		Status int `json:"Status"`
		Answer []struct {
			Data string `json:"data"`
		} `json:"Answer"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return err
	}
	if data.Status == 0 && len(data.Answer) > 0 && data.Answer[0].Data != "" {
		return nil
	}
	return errors.New("no answer")
}

// hostOf returns the hostname of a URL.
func hostOf(raw string) string {
	if u, err := url.Parse(raw); err == nil && u.Hostname() != "" {
		return u.Hostname()
	}
	return raw
}
