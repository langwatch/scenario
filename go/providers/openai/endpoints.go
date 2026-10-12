package openai

import (
	"os"
	"slices"
	"strings"
)

// Endpoint describes an OpenAI-compatible Chat Completions server: where it
// listens and which environment variables hold its address and key.
type Endpoint struct {
	// BaseURL is the default address, such as "https://openrouter.ai/api/v1".
	BaseURL string
	// BaseURLEnv lists environment variables that override BaseURL; the
	// first one set wins.
	BaseURLEnv []string
	// PathSuffix is appended to an address taken from the environment when
	// it lacks it, for servers whose usual env value omits the OpenAI path
	// (OLLAMA_API_BASE is "http://localhost:11434", the API is under /v1).
	PathSuffix string
	// APIKeyEnv lists environment variables holding the API key; the first
	// one set wins.
	APIKeyEnv []string
	// KeyOptional lets local servers (Ollama, vLLM, a LiteLLM proxy without
	// auth) run without a key.
	KeyOptional bool
	// Headers are sent with every request.
	Headers map[string]string
	// LegacyParams sends only long-standing request fields (see
	// Provider.LegacyParams).
	LegacyParams bool
}

// endpoints are the OpenAI-compatible servers known by registry name. The
// names and environment variables follow LiteLLM's (the Python SDK's model
// strings) and, where they differ, the AI SDK's (the JS SDK's).
var endpoints = map[string]Endpoint{
	"openrouter": {
		BaseURL:    "https://openrouter.ai/api/v1",
		BaseURLEnv: []string{"OPENROUTER_API_BASE", "OPENROUTER_BASE_URL"},
		APIKeyEnv:  []string{"OPENROUTER_API_KEY"},
	},
	"ollama": {
		BaseURL:      "http://localhost:11434/v1",
		BaseURLEnv:   []string{"OLLAMA_API_BASE", "OLLAMA_BASE_URL", "OLLAMA_HOST"},
		PathSuffix:   "/v1",
		APIKeyEnv:    []string{"OLLAMA_API_KEY"},
		KeyOptional:  true,
		LegacyParams: true,
	},
	"groq": {
		BaseURL:    "https://api.groq.com/openai/v1",
		BaseURLEnv: []string{"GROQ_API_BASE", "GROQ_BASE_URL"},
		APIKeyEnv:  []string{"GROQ_API_KEY"},
	},
	"together_ai": {
		BaseURL:      "https://api.together.xyz/v1",
		BaseURLEnv:   []string{"TOGETHER_API_BASE", "TOGETHER_BASE_URL"},
		APIKeyEnv:    []string{"TOGETHER_API_KEY", "TOGETHERAI_API_KEY", "TOGETHER_AI_API_KEY"},
		LegacyParams: true,
	},
	"hosted_vllm": {
		BaseURL:      "http://localhost:8000/v1",
		BaseURLEnv:   []string{"HOSTED_VLLM_API_BASE", "VLLM_API_BASE", "VLLM_BASE_URL"},
		APIKeyEnv:    []string{"HOSTED_VLLM_API_KEY", "VLLM_API_KEY"},
		KeyOptional:  true,
		LegacyParams: true,
	},
	"litellm_proxy": {
		BaseURL:     "http://localhost:4000",
		BaseURLEnv:  []string{"LITELLM_PROXY_API_BASE", "LITELLM_BASE_URL"},
		APIKeyEnv:   []string{"LITELLM_PROXY_API_KEY", "LITELLM_API_KEY"},
		KeyOptional: true,
	},
	"mistral": {
		BaseURL:      "https://api.mistral.ai/v1",
		BaseURLEnv:   []string{"MISTRAL_API_BASE", "MISTRAL_BASE_URL"},
		APIKeyEnv:    []string{"MISTRAL_API_KEY"},
		LegacyParams: true,
	},
	"deepseek": {
		BaseURL:      "https://api.deepseek.com/v1",
		BaseURLEnv:   []string{"DEEPSEEK_API_BASE", "DEEPSEEK_BASE_URL"},
		APIKeyEnv:    []string{"DEEPSEEK_API_KEY"},
		LegacyParams: true,
	},
	"xai": {
		BaseURL:    "https://api.x.ai/v1",
		BaseURLEnv: []string{"XAI_API_BASE", "XAI_BASE_URL"},
		APIKeyEnv:  []string{"XAI_API_KEY"},
	},
	"fireworks_ai": {
		BaseURL:      "https://api.fireworks.ai/inference/v1",
		BaseURLEnv:   []string{"FIREWORKS_AI_API_BASE", "FIREWORKS_BASE_URL"},
		APIKeyEnv:    []string{"FIREWORKS_AI_API_KEY", "FIREWORKS_API_KEY"},
		LegacyParams: true,
	},
}

// aliases map other common names to the canonical endpoint names above.
var aliases = map[string]string{
	"together":  "together_ai",
	"vllm":      "hosted_vllm",
	"litellm":   "litellm_proxy",
	"fireworks": "fireworks_ai",
}

// EndpointFor returns the known OpenAI-compatible endpoint of a registry
// name ("openrouter", "ollama", "groq", "together_ai", "hosted_vllm",
// "litellm_proxy", "mistral", …, or one of their aliases).
func EndpointFor(name string) (Endpoint, bool) {
	name = strings.ToLower(name)
	if canonical, ok := aliases[name]; ok {
		name = canonical
	}
	ep, ok := endpoints[name]
	return ep, ok
}

// ProviderNames lists every registry name Register installs: "openai",
// "azure" and the OpenAI-compatible endpoints with their aliases.
func ProviderNames() []string {
	names := []string{"openai", "azure"}
	for name := range endpoints {
		names = append(names, name)
	}
	for alias := range aliases {
		names = append(names, alias)
	}
	slices.Sort(names)
	return names
}

// firstEnv returns the value of the first set, non-empty variable.
func firstEnv(names ...string) string {
	for _, n := range names {
		if v := strings.TrimSpace(os.Getenv(n)); v != "" {
			return v
		}
	}
	return ""
}

// normalizeBaseURL adds a missing scheme ("localhost:11434", the
// OLLAMA_HOST style) and the endpoint's path suffix.
func normalizeBaseURL(raw, suffix string) string {
	u := strings.TrimRight(raw, "/")
	if !strings.Contains(u, "://") {
		u = "http://" + u
	}
	if suffix != "" && !strings.HasSuffix(u, suffix) {
		u += suffix
	}
	return u
}
