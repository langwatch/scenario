// Package ngrok is a tunnel.Provider over ngrok (golang.ngrok.com/ngrok/v2).
//
// It is a separate module so the ngrok agent and its dependency tree never
// enter the voice module: import it only where an ngrok tunnel is wanted.
//
//	a, _ := twilio.New(twilio.Options{..., Tunnel: ngrok.Provider{}})
package ngrok

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"

	"github.com/langwatch/scenario/go/voice/tunnel"
	ngrok "golang.ngrok.com/ngrok/v2"
)

// Provider opens ngrok tunnels: stable URLs under the account's quota.
type Provider struct {
	// AuthToken authenticates the agent; default $NGROK_AUTHTOKEN.
	AuthToken string
	// URL requests a specific endpoint URL, such as a reserved domain
	// ("https://my-app.ngrok.app"); empty lets ngrok assign one.
	URL string
	// ConnectURL overrides the ngrok agent ingress (host:port), for example
	// to pin a region; empty uses ngrok's default.
	ConnectURL string
}

var _ tunnel.Provider = Provider{}

// Open implements tunnel.Provider: an HTTPS endpoint forwarding to the
// local port.
func (p Provider) Open(ctx context.Context, port int) (tunnel.Tunnel, error) {
	token := p.AuthToken
	if token == "" {
		token = os.Getenv("NGROK_AUTHTOKEN")
	}
	if token == "" {
		return nil, errors.New("ngrok: no auth token; set Provider.AuthToken or NGROK_AUTHTOKEN")
	}
	opts := []ngrok.AgentOption{ngrok.WithAuthtoken(token)}
	if p.ConnectURL != "" {
		opts = append(opts, ngrok.WithAgentConnectURL(p.ConnectURL))
	}
	agent, err := ngrok.NewAgent(opts...)
	if err != nil {
		return nil, fmt.Errorf("ngrok: creating the agent: %w", err)
	}
	var epOpts []ngrok.EndpointOption
	if p.URL != "" {
		epOpts = append(epOpts, ngrok.WithURL(p.URL))
	}
	fw, err := agent.Forward(ctx, ngrok.WithUpstream("http://127.0.0.1:"+strconv.Itoa(port)), epOpts...)
	if err != nil {
		_ = agent.Disconnect()
		return nil, fmt.Errorf("ngrok: forwarding port %d: %w", port, err)
	}
	if fw.URL() == nil || fw.URL().String() == "" {
		_ = fw.Close()
		_ = agent.Disconnect()
		return nil, errors.New("ngrok: forward returned no URL")
	}
	return &ngrokTunnel{agent: agent, fw: fw}, nil
}

type ngrokTunnel struct {
	agent ngrok.Agent
	fw    ngrok.EndpointForwarder
}

func (t *ngrokTunnel) URL() string { return t.fw.URL().String() }

// Close closes the endpoint and disconnects the agent.
func (t *ngrokTunnel) Close() error {
	err := t.fw.Close()
	if derr := t.agent.Disconnect(); err == nil {
		err = derr
	}
	return err
}
