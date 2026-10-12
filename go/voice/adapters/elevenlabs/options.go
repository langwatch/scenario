package elevenlabs

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/coder/websocket"
	el "github.com/langwatch/scenario/go/voice/internal/elevenlabs"
)

// TurnCommitMode is how a user turn is committed to the hosted agent.
type TurnCommitMode string

// Turn commit modes.
const (
	// CommitAudio (the default) streams the turn's real PCM as 20 ms
	// user_audio_chunk frames at microphone cadence, then closing silence
	// until the agent answers: the agent's own STT and VAD run on the user's
	// voice. It is the only mode in which a passing run says anything about
	// them.
	CommitAudio TurnCommitMode = "audio"
	// CommitText sends only {"type":"user_message","text":...} with the
	// chunk's transcript and no audio, committing the turn deterministically
	// without server VAD. The agent never hears the user. A chunk without a
	// transcript falls back to CommitSilence.
	CommitText TurnCommitMode = "text"
	// CommitSilence streams the speech followed by a bounded zero-byte tail
	// of SilenceTailBytes, the behaviour before the continuous mic.
	CommitSilence TurnCommitMode = "silence"
)

// DefaultSilenceTailBytes is the CommitSilence tail: 16000 zero bytes,
// about 333 ms at 24 kHz.
const DefaultSilenceTailBytes = 16000

// Dialer opens the session WebSocket at url.
type Dialer func(ctx context.Context, url string) (*websocket.Conn, error)

// Options configure a [Transport]. Only AgentID is required. Values given
// here are used as is; the environment is read only for unset ones.
type Options struct {
	// AgentID is the ElevenLabs Conversational AI agent.
	AgentID string
	// APIKey is sent as xi-api-key to mint the signed session URL. Unset, it
	// falls back to ELEVENLABS_CONVAI_API_KEY, then ELEVENLABS_API_KEY.
	// Against a LangWatch AI Gateway it carries a LangWatch virtual key.
	APIKey string
	// BaseURL is the REST base (without /v1) the signed URL is minted from,
	// for example a LangWatch AI Gateway. Unset, it falls back to
	// ELEVENLABS_BASE_URL, then https://api.elevenlabs.io. The WebSocket the
	// signed URL names still belongs to ElevenLabs.
	BaseURL string
	// HTTPClient makes the signed-URL request; defaults to
	// http.DefaultClient. The default Dialer uses it too.
	HTTPClient *http.Client
	// Dialer opens the WebSocket; defaults to websocket.Dial with
	// HTTPClient.
	Dialer Dialer

	// SystemPromptOverride sets conversation_config_override.agent.prompt.prompt.
	SystemPromptOverride string
	// FirstMessageOverride sets conversation_config_override.agent.first_message.
	FirstMessageOverride string
	// DynamicVariables are forwarded as the handshake's dynamic_variables,
	// keeping their JSON types (string, number or bool). Nil sends none.
	DynamicVariables map[string]any
	// Overrides are deep-merged into conversation_config_override, under
	// the two narrow overrides above (which win on the same leaf).
	Overrides map[string]any

	// TurnCommitMode defaults to CommitAudio.
	TurnCommitMode TurnCommitMode
	// SilenceTailBytes is the CommitSilence tail; defaults to
	// DefaultSilenceTailBytes.
	SilenceTailBytes int

	// Logger receives the transport's warnings and debug diagnostics;
	// defaults to slog.Default().
	Logger *slog.Logger
}

// resolved returns o with defaults applied and the base URL checked, so a
// misconfiguration fails at construction, not at the first request.
func (o Options) resolved() (Options, error) {
	if strings.TrimSpace(o.AgentID) == "" {
		return o, fmt.Errorf("ElevenLabsAgentAdapter: AgentID is required")
	}
	if strings.TrimSpace(o.APIKey) == "" {
		o.APIKey = el.ResolveConvAIAPIKey("")
	} else {
		o.APIKey = strings.TrimSpace(o.APIKey)
	}
	base, err := el.ResolveConvAIBaseURL(o.BaseURL)
	if err != nil {
		return o, err
	}
	if base == "" {
		base = el.DefaultBaseURL
	}
	o.BaseURL = base
	switch o.TurnCommitMode {
	case "":
		o.TurnCommitMode = CommitAudio
	case CommitAudio, CommitText, CommitSilence:
	default:
		return o, fmt.Errorf("unknown TurnCommitMode %q; expected %q, %q or %q",
			o.TurnCommitMode, CommitAudio, CommitText, CommitSilence)
	}
	switch {
	case o.SilenceTailBytes == 0:
		o.SilenceTailBytes = DefaultSilenceTailBytes
	case o.SilenceTailBytes < 0:
		return o, fmt.Errorf("SilenceTailBytes must be positive, got %d", o.SilenceTailBytes)
	}
	if o.HTTPClient == nil {
		o.HTTPClient = http.DefaultClient
	}
	if o.Dialer == nil {
		client := o.HTTPClient
		o.Dialer = func(ctx context.Context, url string) (*websocket.Conn, error) {
			conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPClient: client})
			return conn, err
		}
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	return o, nil
}

// conversationConfigOverride is the handshake's override: the caller's
// Overrides with the narrow prompt and first-message knobs layered on top.
// The agent object is always present (empty is a no-op) so the handshake
// shape is stable.
func (o Options) conversationConfigOverride() map[string]any {
	agent := map[string]any{}
	if o.SystemPromptOverride != "" {
		agent["prompt"] = map[string]any{"prompt": o.SystemPromptOverride}
	}
	if o.FirstMessageOverride != "" {
		agent["first_message"] = o.FirstMessageOverride
	}
	return deepMerge(o.Overrides, map[string]any{"agent": agent})
}

// deepMerge returns a new map with layer merged on top of base: keys holding
// objects on both sides merge recursively; otherwise layer wins where it has
// the key. Neither argument is modified.
func deepMerge(base, layer map[string]any) map[string]any {
	out := make(map[string]any, len(base)+len(layer))
	for k, v := range base {
		out[k] = v
	}
	for k, lv := range layer {
		bm, bok := out[k].(map[string]any)
		lm, lok := lv.(map[string]any)
		if bok && lok {
			out[k] = deepMerge(bm, lm)
			continue
		}
		out[k] = lv
	}
	return out
}
