package tunnel

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"strconv"
	"sync"
	"syscall"
	"time"
)

// DefaultCloudflaredStartupTimeout bounds the wait for cloudflared to
// announce its quick-tunnel hostname.
const DefaultCloudflaredStartupTimeout = 30 * time.Second

// trycloudflareRE matches the hostname cloudflared prints at startup.
var trycloudflareRE = regexp.MustCompile(`https://[a-z0-9-]+\.trycloudflare\.com`)

// Cloudflared opens Cloudflare quick tunnels (*.trycloudflare.com) by
// running the cloudflared binary: no account, no Go dependency. It is the
// twin of the Python SDK's CloudflareTunnel and the JavaScript SDK's
// "cloudflared" provider.
//
// The announced URL becomes reachable only once Cloudflare's DNS has
// propagated it; the returned tunnel implements [Readiness] with an
// [EdgeReadiness] probe for that.
type Cloudflared struct {
	// Binary is the cloudflared executable; default "cloudflared" on PATH.
	Binary string
	// StartupTimeout bounds the wait for the hostname; default 30 s.
	StartupTimeout time.Duration
	// Readiness tunes the edge probe of the opened tunnel. Its Host is
	// filled in from the announced URL.
	Readiness EdgeReadiness
}

// Open implements Provider.
func (c Cloudflared) Open(ctx context.Context, port int) (Tunnel, error) {
	bin := c.Binary
	if bin == "" {
		bin = "cloudflared"
	}
	timeout := c.StartupTimeout
	if timeout <= 0 {
		timeout = DefaultCloudflaredStartupTimeout
	}
	cmd := exec.Command(bin, "tunnel", "--url", "http://localhost:"+strconv.Itoa(port), "--no-autoupdate")
	pr, pw := io.Pipe()
	cmd.Stdout, cmd.Stderr = pw, pw
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("tunnel: failed to spawn cloudflared (%v). Install it — Linux: "+
			"https://developers.cloudflare.com/cloudflared/install/ ; macOS: brew install cloudflared", err)
	}
	t := &cloudflaredTunnel{cmd: cmd, exited: make(chan struct{})}
	go func() {
		t.waitErr = cmd.Wait()
		pw.Close()
		close(t.exited)
	}()
	found := make(chan string, 1)
	// Keep draining the child's output for the tunnel's lifetime: cloudflared
	// logs continuously, and an undrained pipe fills and blocks the process,
	// silently killing the tunnel.
	go scanForURL(pr, found)

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case url := <-found:
		t.url = url
		t.ready = c.Readiness
		t.ready.Host = hostOf(url)
		return t, nil
	case <-t.exited:
		return nil, fmt.Errorf("tunnel: cloudflared exited (%s) before announcing a URL", exitStatus(t.waitErr))
	case <-timer.C:
		_ = t.Close()
		return nil, fmt.Errorf("tunnel: cloudflared did not announce a trycloudflare.com URL within %v. "+
			"Check that cloudflared is installed and its output for errors", timeout)
	case <-ctx.Done():
		_ = t.Close()
		return nil, ctx.Err()
	}
}

// scanForURL reads the merged output until the hostname appears, sends it,
// then discards the rest.
func scanForURL(r io.Reader, found chan<- string) {
	var seen []byte
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			seen = append(seen, buf[:n]...)
			if m := trycloudflareRE.Find(seen); m != nil {
				found <- string(m)
				_, _ = io.Copy(io.Discard, r)
				return
			}
			// Keep a tail long enough to hold a URL split across reads.
			if len(seen) > 64<<10 {
				seen = bytes.Clone(seen[len(seen)-1024:])
			}
		}
		if err != nil {
			return
		}
	}
}

func exitStatus(err error) string {
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return "code " + strconv.Itoa(ee.ExitCode())
	}
	if err == nil {
		return "code 0"
	}
	return err.Error()
}

type cloudflaredTunnel struct {
	url     string
	ready   EdgeReadiness
	cmd     *exec.Cmd
	exited  chan struct{}
	waitErr error
	once    sync.Once
}

func (t *cloudflaredTunnel) URL() string { return t.url }

// WaitUntilEdgeReachable implements Readiness.
func (t *cloudflaredTunnel) WaitUntilEdgeReachable(ctx context.Context) error {
	return t.ready.WaitUntilEdgeReachable(ctx)
}

// Close terminates cloudflared: SIGTERM, then a kill if it lingers.
func (t *cloudflaredTunnel) Close() error {
	t.once.Do(func() {
		if err := t.cmd.Process.Signal(syscall.SIGTERM); err != nil {
			_ = t.cmd.Process.Kill()
		}
		select {
		case <-t.exited:
		case <-time.After(5 * time.Second):
			_ = t.cmd.Process.Kill()
			<-t.exited
		}
	})
	return nil
}
