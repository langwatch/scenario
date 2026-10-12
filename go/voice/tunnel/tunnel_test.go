package tunnel

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// fakeCloudflared writes a shell script standing in for the binary.
func fakeCloudflared(t *testing.T, body string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell-script fake needs a POSIX shell")
	}
	path := filepath.Join(t.TempDir(), "cloudflared")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCloudflaredAnnouncesURL(t *testing.T) {
	bin := fakeCloudflared(t, `echo "INF Requesting new quick Tunnel on trycloudflare.com..." >&2
echo "INF |  https://brave-lion-42.trycloudflare.com  |" >&2
while true; do echo "INF keepalive"; sleep 0.01; done`)
	tun, err := Cloudflared{Binary: bin}.Open(context.Background(), 8767)
	if err != nil {
		t.Fatal(err)
	}
	if tun.URL() != "https://brave-lion-42.trycloudflare.com" {
		t.Fatalf("URL = %q", tun.URL())
	}
	if ct := tun.(*cloudflaredTunnel); ct.ready.Host != "brave-lion-42.trycloudflare.com" {
		t.Fatalf("readiness host = %q", ct.ready.Host)
	}
	// The process keeps logging after the URL; draining keeps it alive.
	time.Sleep(50 * time.Millisecond)
	select {
	case <-tun.(*cloudflaredTunnel).exited:
		t.Fatal("cloudflared died after announcing its URL")
	default:
	}
	if err := tun.Close(); err != nil {
		t.Fatal(err)
	}
	<-tun.(*cloudflaredTunnel).exited
}

func TestCloudflaredExitsBeforeURL(t *testing.T) {
	bin := fakeCloudflared(t, `echo "ERR failed to start" >&2; exit 3`)
	_, err := Cloudflared{Binary: bin}.Open(context.Background(), 1)
	if err == nil || !strings.Contains(err.Error(), "exited (code 3) before announcing a URL") {
		t.Fatalf("err = %v", err)
	}
}

// cloudflared names the API host in the error it logs before exiting when
// it cannot get a quick tunnel; that is not a tunnel URL.
func TestCloudflaredIgnoresTheAPIHost(t *testing.T) {
	bin := fakeCloudflared(t, `echo 'ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: i/o timeout' >&2; exit 1`)
	_, err := Cloudflared{Binary: bin}.Open(context.Background(), 1)
	if err == nil || !strings.Contains(err.Error(), "exited (code 1) before announcing a URL") {
		t.Fatalf("err = %v", err)
	}

	bin = fakeCloudflared(t, `echo 'WRN retrying https://api.trycloudflare.com/tunnel' >&2
echo "INF |  https://calm-otter-7.trycloudflare.com  |" >&2
exec sleep 5`)
	tun, err := Cloudflared{Binary: bin}.Open(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	defer tun.Close()
	if tun.URL() != "https://calm-otter-7.trycloudflare.com" {
		t.Fatalf("URL = %q", tun.URL())
	}
}

func TestCloudflaredStartupTimeout(t *testing.T) {
	bin := fakeCloudflared(t, `sleep 5`)
	_, err := Cloudflared{Binary: bin, StartupTimeout: 50 * time.Millisecond}.Open(context.Background(), 1)
	if err == nil || !strings.Contains(err.Error(), "did not announce") {
		t.Fatalf("err = %v", err)
	}
}

func TestCloudflaredMissingBinary(t *testing.T) {
	_, err := Cloudflared{Binary: filepath.Join(t.TempDir(), "nope")}.Open(context.Background(), 1)
	if err == nil || !strings.Contains(err.Error(), "failed to spawn cloudflared") {
		t.Fatalf("err = %v", err)
	}
}

func noLookup(context.Context, string) ([]net.IP, error) { return nil, errors.New("nxdomain") }

func TestEdgeReadinessReadyOnFirstAnswer(t *testing.T) {
	var asked string
	doh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = r.URL.Query().Get("name") + "/" + r.URL.Query().Get("type")
		_, _ = w.Write([]byte(`{"Status":0,"Answer":[{"data":"104.16.0.1"}]}`))
	}))
	defer doh.Close()
	e := EdgeReadiness{Host: "x.trycloudflare.com", DoHEndpoints: []string{doh.URL}, LookupIP4: noLookup}
	if err := e.WaitUntilEdgeReachable(context.Background()); err != nil {
		t.Fatal(err)
	}
	if asked != "x.trycloudflare.com/A" {
		t.Fatalf("asked %q", asked)
	}
	// The system resolver alone suffices too.
	e = EdgeReadiness{Host: "x", DoHEndpoints: []string{}, LookupIP4: func(context.Context, string) ([]net.IP, error) {
		return []net.IP{net.IPv4(1, 2, 3, 4)}, nil
	}}
	if err := e.WaitUntilEdgeReachable(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestEdgeReadinessTimesOutAsNotReady(t *testing.T) {
	doh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"Status":3}`))
	}))
	defer doh.Close()
	e := EdgeReadiness{Host: "late.trycloudflare.com", DoHEndpoints: []string{doh.URL}, LookupIP4: noLookup,
		Timeout: 60 * time.Millisecond, Interval: 10 * time.Millisecond}
	err := e.WaitUntilEdgeReachable(context.Background())
	if !IsNotReady(err) || !strings.Contains(err.Error(), "did not become globally resolvable") ||
		!strings.Contains(err.Error(), "no answer") {
		t.Fatalf("err = %v", err)
	}
}
