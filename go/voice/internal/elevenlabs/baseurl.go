// Package elevenlabs decides where ElevenLabs requests go and which key
// they carry, in one place for the speech-to-text, text-to-speech and hosted
// conversational adapters.
//
// ELEVENLABS_BASE_URL is scenario's own variable, not the vendor's. It moves
// only the hosted ConvAI signed-URL mint (for example onto a LangWatch AI
// Gateway, which fronts that one route). Speech-to-text and text-to-speech
// take an explicit base URL and never read the variable: the gateway answers
// 404 for their routes, so honouring it there would break every composed
// ElevenLabs voice in a process configured for the ConvAI demos.
package elevenlabs

import (
	"fmt"
	"net/url"
	"os"
	"strings"
)

// Environment variables and the vendor default.
const (
	BaseURLEnv      = "ELEVENLABS_BASE_URL"
	ConvAIAPIKeyEnv = "ELEVENLABS_CONVAI_API_KEY"
	APIKeyEnv       = "ELEVENLABS_API_KEY"
	DefaultBaseURL  = "https://api.elevenlabs.io"
)

// NormalizeBaseURL checks a base URL where the mistake is still readable
// and returns it without trailing slashes. Blank means unset and yields "".
// A URL ending in /v1 is refused: the client appends /v1 itself, so it would
// request /v1/v1/... and get a 404 that names no cause.
func NormalizeBaseURL(raw string) (string, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return "", nil
	}
	u, err := url.Parse(trimmed)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("ElevenLabs baseUrl is not a URL: %s", trimmed)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("ElevenLabs baseUrl must be http or https: %s", trimmed)
	}
	if strings.HasSuffix(u.Path, "/v1") {
		return "", fmt.Errorf("ElevenLabs baseUrl must not include /v1 (%s). "+
			"The client appends it, so this would request /v1/v1/convai/... and 404", trimmed)
	}
	return trimmed, nil
}

// ResolveConvAIBaseURL is the base URL for the surface a gateway fronts: the
// explicit value, else ELEVENLABS_BASE_URL. Blank counts as unset at both
// steps; "" means the vendor default.
func ResolveConvAIBaseURL(explicit string) (string, error) {
	if strings.TrimSpace(explicit) != "" {
		return NormalizeBaseURL(explicit)
	}
	return NormalizeBaseURL(os.Getenv(BaseURLEnv))
}

// ResolveConvAIAPIKey is the key the hosted ConvAI adapter presents: the
// explicit value, else ELEVENLABS_CONVAI_API_KEY, else ELEVENLABS_API_KEY.
// Whitespace-only candidates are skipped so a stray space cannot shadow a
// real key with a 401.
func ResolveConvAIAPIKey(explicit string) string {
	for _, c := range []string{explicit, os.Getenv(ConvAIAPIKeyEnv), os.Getenv(APIKeyEnv)} {
		if c = strings.TrimSpace(c); c != "" {
			return c
		}
	}
	return ""
}

// LeafBaseURL is the base URL for speech-to-text and text-to-speech: the
// explicit value when set (normalized), else the vendor default. The
// environment is deliberately not consulted.
func LeafBaseURL(explicit string) (string, error) {
	u, err := NormalizeBaseURL(explicit)
	if err != nil || u != "" {
		return u, err
	}
	return DefaultBaseURL, nil
}

// LeafAPIKey is the key for speech-to-text and text-to-speech: the explicit
// value, else ELEVENLABS_API_KEY.
func LeafAPIKey(explicit string) string {
	if explicit != "" {
		return explicit
	}
	return os.Getenv(APIKeyEnv)
}
