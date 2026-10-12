package elevenlabs

import (
	"strings"
	"testing"
)

// Ported from javascript/src/voice/adapters/__tests__/elevenlabs-base-url.test.ts
// and javascript/src/voice/__tests__/elevenlabs-base-url-scope.test.ts.

func TestNormalizeBaseURL(t *testing.T) {
	refused := map[string]string{
		"https://gw.example.com/v1":  "/v1",
		"https://gw.example.com/v1/": "/v1",
		"not a url":                  "not a URL",
		"ftp://gw.example.com":       "http or https",
	}
	for in, want := range refused {
		if _, err := NormalizeBaseURL(in); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("NormalizeBaseURL(%q) err = %v, want mention of %q", in, err, want)
		}
	}
	if got, err := NormalizeBaseURL("https://gw.example.com/"); err != nil || got != "https://gw.example.com" {
		t.Errorf("host root: %q, %v", got, err)
	}
	for _, blank := range []string{"", "   "} {
		if got, err := NormalizeBaseURL(blank); err != nil || got != "" {
			t.Errorf("blank %q: %q, %v", blank, got, err)
		}
	}
}

func TestConvAIBaseURLReadsEnvironment(t *testing.T) {
	t.Setenv(BaseURLEnv, "https://gateway.example.com")
	if got, _ := ResolveConvAIBaseURL(""); got != "https://gateway.example.com" {
		t.Errorf("from env: %q", got)
	}
	if got, _ := ResolveConvAIBaseURL("https://explicit.example.com"); got != "https://explicit.example.com" {
		t.Errorf("explicit: %q", got)
	}
	if got, _ := ResolveConvAIBaseURL("  "); got != "https://gateway.example.com" {
		t.Errorf("blank explicit should fall through: %q", got)
	}
}

func TestLeafBaseURLIgnoresEnvironment(t *testing.T) {
	t.Setenv(BaseURLEnv, "https://gateway.example.com")
	if got, _ := LeafBaseURL(""); got != DefaultBaseURL {
		t.Errorf("leaf followed the ConvAI variable: %q", got)
	}
	if got, _ := LeafBaseURL("https://explicit.example.com/"); got != "https://explicit.example.com" {
		t.Errorf("explicit leaf: %q", got)
	}
	if _, err := LeafBaseURL("https://explicit.example.com/v1"); err == nil {
		t.Error("leaf accepted /v1")
	}
}

func TestConvAIAPIKeyPrecedence(t *testing.T) {
	t.Setenv(ConvAIAPIKeyEnv, "convai")
	t.Setenv(APIKeyEnv, "vendor")
	if got := ResolveConvAIAPIKey(""); got != "convai" {
		t.Errorf("got %q, want convai", got)
	}
	if got := ResolveConvAIAPIKey("explicit"); got != "explicit" {
		t.Errorf("got %q, want explicit", got)
	}
	t.Setenv(ConvAIAPIKeyEnv, "  ")
	if got := ResolveConvAIAPIKey(""); got != "vendor" {
		t.Errorf("blank candidate shadowed the vendor key: %q", got)
	}
	t.Setenv(APIKeyEnv, "")
	if got := ResolveConvAIAPIKey(" "); got != "" {
		t.Errorf("got %q, want no key", got)
	}
}
