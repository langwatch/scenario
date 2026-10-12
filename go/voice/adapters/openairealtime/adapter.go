package openairealtime

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/coder/websocket"
	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/broker"
	"go.opentelemetry.io/otel/attribute"
)

// Model defaults, the same as the JavaScript and Python SDKs.
const (
	// DefaultModel is the default Realtime model.
	DefaultModel = "gpt-realtime-mini"
	// DefaultVoice is the default output voice.
	DefaultVoice = "alloy"
	// TranscriptionModel drives the session's inline user transcript.
	TranscriptionModel = "gpt-4o-transcribe"
	// DefaultURL is the vendor endpoint; {model} is replaced by the model.
	DefaultURL = "wss://api.openai.com/v1/realtime?model={model}"
)

// Tool is a Realtime function tool definition, passed through to the
// session.
type Tool struct {
	Name        string
	Description string
	// Parameters is the JSON Schema of the arguments.
	Parameters any
}

// MarshalJSON encodes the tool as {"type":"function", …}.
func (t Tool) MarshalJSON() ([]byte, error) {
	v := struct {
		Type        string `json:"type"`
		Name        string `json:"name"`
		Description string `json:"description,omitempty"`
		Parameters  any    `json:"parameters,omitempty"`
	}{"function", t.Name, t.Description, t.Parameters}
	return json.Marshal(v)
}

// Options configure an Adapter. Zero fields take the defaults.
type Options struct {
	// Model defaults to DefaultModel.
	Model string
	// Voice defaults to DefaultVoice.
	Voice string
	// Instructions are the session's system instructions (the persona, for
	// the user role).
	Instructions string
	// Tools are passed through to the session.
	Tools []Tool
	// APIKey is the key for dialing the vendor directly; it falls back to
	// OPENAI_REALTIME_API_KEY, then OPENAI_API_KEY. It is used only when no
	// session is minted.
	APIKey string
	// Role is AgentRoleAgent (default: the model is the agent under test) or
	// AgentRoleUser (the model is the voice user simulator).
	Role scenario.AgentRole
	// URL overrides the endpoint (default OPENAI_REALTIME_URL, else
	// DefaultURL); {model} is replaced by the model.
	URL string
	// Mint overrides where the session credential is minted; its zero fields
	// fall back to OPENAI_BASE_URL and OPENAI_API_KEY.
	Mint *broker.Endpoint
	// NoMint skips the mint and dials the vendor directly.
	NoMint bool
	// HTTPClient carries the mint, the usage report and the WebSocket
	// handshake. Its Timeout must be zero (contexts bound the calls).
	HTTPClient *http.Client
	// Dial replaces the WebSocket dial (tests, proxies).
	Dial DialFunc
	// UserTurnTailTimeout ends a spoken user turn after this much idle time
	// (default 15s).
	UserTurnTailTimeout time.Duration
	// Logger receives the adapter's warnings and debug lines; defaults to
	// slog.Default().
	Logger *slog.Logger
}

// Adapter is the OpenAI Realtime scenario agent. It runs the default voice
// turn of the embedded voice.Agent (set its timing fields before the run)
// and adds the turn's tool calls; with the user role it is the realtime
// user simulator, speaking scripted lines (voice.RealtimeUser) and
// generating its own turns.
type Adapter struct {
	*voice.Agent
	rt *Transport
}

// New returns an adapter.
func New(o Options) *Adapter {
	rt := newTransport(o)
	role := o.Role
	if role == "" {
		role = scenario.AgentRoleAgent
	}
	return &Adapter{Agent: voice.NewAgent(rt, voice.WithRole(role)), rt: rt}
}

func newTransport(o Options) *Transport {
	t := &Transport{
		model:               firstNonEmpty(o.Model, DefaultModel),
		voiceName:           firstNonEmpty(o.Voice, DefaultVoice),
		instructions:        o.Instructions,
		tools:               o.Tools,
		httpClient:          o.HTTPClient,
		dial:                o.Dial,
		logger:              o.Logger,
		UserTurnTailTimeout: o.UserTurnTailTimeout,
	}
	if t.logger == nil {
		t.logger = slog.Default()
	}
	if t.UserTurnTailTimeout <= 0 {
		t.UserTurnTailTimeout = DefaultUserTurnTailTimeout
	}
	// OPENAI_REALTIME_API_KEY lets a deployment whose OPENAI_API_KEY is a
	// virtual key still hold a provider key for this socket. The source is
	// named in the direct-dial warning.
	switch {
	case o.APIKey != "":
		t.apiKey, t.apiKeySource = o.APIKey, "the APIKey passed to the adapter"
	case os.Getenv("OPENAI_REALTIME_API_KEY") != "":
		t.apiKey, t.apiKeySource = os.Getenv("OPENAI_REALTIME_API_KEY"), "OPENAI_REALTIME_API_KEY"
	default:
		t.apiKey, t.apiKeySource = os.Getenv("OPENAI_API_KEY"), "OPENAI_API_KEY"
	}
	t.url = firstNonEmpty(o.URL, os.Getenv("OPENAI_REALTIME_URL"), DefaultURL)
	t.url = strings.ReplaceAll(t.url, "{model}", t.model)
	if !o.NoMint {
		t.mint = broker.ResolveEndpoint(o.Mint)
	}
	if t.dial == nil {
		client := t.httpClient
		t.dial = func(ctx context.Context, url string, header http.Header) (*websocket.Conn, error) {
			c, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPClient: client, HTTPHeader: header})
			return c, err
		}
	}
	return t
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if v != "" {
			return v
		}
	}
	return ""
}

// Realtime returns the transport, for adapter-level calls.
func (a *Adapter) Realtime() *Transport { return a.rt }

// SpeakUserTurn implements voice.RealtimeUser: see Transport.SpeakUserTurn.
func (a *Adapter) SpeakUserTurn(ctx context.Context, text string) (voice.AudioChunk, error) {
	return a.rt.SpeakUserTurn(ctx, text)
}

// String hides the API key.
func (a *Adapter) String() string {
	return fmt.Sprintf("%s(model='%s', voice='%s', role='%s', api_key='***')", className, a.rt.model, a.rt.voiceName, a.Role())
}

// GoString hides the API key from %#v.
func (a *Adapter) GoString() string { return a.String() }

// Call implements scenario.AgentAdapter. As the agent, it runs the default
// voice turn and appends one tool message per function call the model made
// in it. As the user, it runs the autonomous user turn.
func (a *Adapter) Call(ctx context.Context, in scenario.AgentInput) (*scenario.AgentReturn, error) {
	if a.Role() == scenario.AgentRoleUser {
		return a.autonomousUserTurn(ctx, in)
	}
	// Tool calls are turn-scoped: a prior turn's calls never bleed through.
	a.rt.resetToolCalls()
	msgs, err := a.Turn(ctx, in)
	if err != nil {
		return nil, err
	}
	if calls := a.rt.ToolCalls(); len(calls) > 0 {
		msgs = append(msgs, toolMessages(calls)...)
	}
	return scenario.MessagesReturn(msgs...), nil
}

// autonomousUserTurn is the generated (Proceed) turn of the realtime user:
// the model hears the agent's last turn, its audio fed into the input
// buffer, then speaks the next customer line, returned as the user's audio
// turn. It never runs the default voice turn, which would only time out
// with turn detection off. Its spans mirror the default turn's:
// voice.turn > voice.audio.send, voice.audio.receive.
func (a *Adapter) autonomousUserTurn(ctx context.Context, in scenario.AgentInput) (*scenario.AgentReturn, error) {
	if !a.rt.IsConnected() {
		return nil, errNotConnected
	}
	attrs := []attribute.KeyValue{attribute.String("voice.adapter.class", a.Name())}
	if in.ScenarioState != nil {
		attrs = append(attrs, attribute.Int("voice.turn.index", in.ScenarioState.CurrentTurn()))
	}
	ctx, turnSpan := voice.StartSpan(ctx, voice.SpanTurn, attrs...)
	start := time.Now()
	chunk, err := a.hearAndSpeak(ctx, in)
	voice.SetSpanAttributes(turnSpan, attribute.Int64("voice.turn.latency_ms", time.Since(start).Milliseconds()))
	voice.EndSpan(turnSpan, err)
	if err != nil {
		return nil, err
	}
	return scenario.MessagesReturn(voice.AudioMessage(chunk, scenario.RoleUser)), nil
}

func (a *Adapter) hearAndSpeak(ctx context.Context, in scenario.AgentInput) (voice.AudioChunk, error) {
	// A malformed (odd-byte) payload is not audio: the turn degrades to
	// persona-only generation. No heard audio (the first user turn) does too.
	if n := len(in.NewMessages); n > 0 {
		if heard, ok := voice.ExtractAudio(in.NewMessages[n-1]); ok {
			sctx, span := voice.StartSpan(ctx, voice.SpanAudioSend, attribute.Int("voice.audio.bytes", len(heard.Data)))
			err := a.rt.SendAudio(sctx, heard)
			voice.EndSpan(span, err)
			if err != nil {
				return voice.AudioChunk{}, err
			}
		}
	}
	rctx, span := voice.StartSpan(ctx, voice.SpanAudioReceive)
	chunk, err := a.rt.speakGeneratedTurn(rctx)
	voice.EndSpan(span, err)
	return chunk, err
}
