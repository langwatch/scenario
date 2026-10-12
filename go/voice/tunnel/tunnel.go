// Package tunnel exposes a local port on a public HTTPS URL, so a telephony
// provider (Twilio) can reach a webhook and media-stream server running on a
// dev machine or CI runner.
//
// [Cloudflared] shells out to the cloudflared binary for a free
// *.trycloudflare.com quick tunnel and needs no account. An ngrok provider
// lives in the separate module github.com/langwatch/scenario/go/voice/tunnel/ngrok,
// so its dependency tree never enters the voice module. The JavaScript SDK's
// localtunnel provider has no Go equivalent and is not offered.
package tunnel

import (
	"context"
	"errors"
)

// Tunnel is an open tunnel.
type Tunnel interface {
	// URL is the public HTTPS URL proxying to the local port.
	URL() string
	// Close tears the tunnel down.
	Close() error
}

// Provider opens tunnels.
type Provider interface {
	// Open exposes the local port and returns once the provider announced
	// the public URL. The URL may not be reachable from everywhere yet; see
	// [Readiness].
	Open(ctx context.Context, port int) (Tunnel, error)
}

// Readiness is implemented by tunnels that can tell when their public URL
// is reachable from the edge. Twilio a-leg origination waits on it, because
// a call whose media stream dials a URL that does not resolve yet connects
// to nothing and bills anyway.
type Readiness interface {
	WaitUntilEdgeReachable(ctx context.Context) error
}

// NotReadyError reports a public URL that is not reachable from the edge.
type NotReadyError struct {
	Msg string
	Err error
}

func (e *NotReadyError) Error() string { return e.Msg }

// Unwrap returns the underlying failure.
func (e *NotReadyError) Unwrap() error { return e.Err }

// IsNotReady reports whether err is, or wraps, a *NotReadyError.
func IsNotReady(err error) bool {
	var nr *NotReadyError
	return errors.As(err, &nr)
}
