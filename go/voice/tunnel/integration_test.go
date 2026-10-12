//go:build integration

package tunnel

import (
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// TestCloudflaredLive opens a real quick tunnel against a local server and
// proxies a request through it. Set SCENARIO_TUNNEL_E2E=1 to run it (it
// needs the cloudflared binary and outbound network).
func TestCloudflaredLive(t *testing.T) {
	if os.Getenv("SCENARIO_TUNNEL_E2E") == "" {
		t.Skip("set SCENARIO_TUNNEL_E2E=1 to open a real cloudflared tunnel")
	}
	if _, err := exec.LookPath("cloudflared"); err != nil {
		t.Skip("cloudflared not installed")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not found", http.StatusNotFound)
	})}
	go srv.Serve(ln)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	tun, err := Cloudflared{}.Open(ctx, ln.Addr().(*net.TCPAddr).Port)
	if err != nil {
		t.Fatal(err)
	}
	defer tun.Close()
	if !strings.HasPrefix(tun.URL(), "https://") {
		t.Fatalf("URL = %q", tun.URL())
	}
	if err := tun.(Readiness).WaitUntilEdgeReachable(ctx); err != nil {
		t.Fatal(err)
	}
	var resp *http.Response
	for ctx.Err() == nil {
		resp, err = http.Get(tun.URL() + "/this-path-404s")
		if err == nil && resp.StatusCode == http.StatusNotFound {
			break
		}
		time.Sleep(time.Second)
	}
	if resp == nil {
		t.Fatalf("tunnel never proxied: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(body), "not found") {
		t.Fatalf("status %d body %q", resp.StatusCode, body)
	}
}
