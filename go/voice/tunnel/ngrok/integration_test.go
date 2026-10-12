//go:build integration

package ngrok

import (
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// TestNgrokLive is the port of twilio-tunnel.test.ts: a tunnel against a
// local server proxies a request through to it. Needs NGROK_AUTHTOKEN.
func TestNgrokLive(t *testing.T) {
	if os.Getenv("NGROK_AUTHTOKEN") == "" {
		t.Skip("set NGROK_AUTHTOKEN to open a real ngrok tunnel")
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
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	tun, err := Provider{}.Open(ctx, ln.Addr().(*net.TCPAddr).Port)
	if err != nil {
		t.Fatal(err)
	}
	defer tun.Close()
	if !strings.HasPrefix(tun.URL(), "https://") {
		t.Fatalf("URL = %q", tun.URL())
	}
	resp, err := http.Get(tun.URL() + "/this-path-404s")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound || !strings.Contains(string(body), "not found") {
		t.Fatalf("status %d body %q", resp.StatusCode, body)
	}
}
