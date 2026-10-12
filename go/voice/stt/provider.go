// Package stt turns canonical audio into text. A [Provider] is the whole
// contract (one method), and a [Registry] resolves litellm-style
// "provider/model" specs such as "openai/gpt-4o-transcribe" or
// "elevenlabs/scribe_v1" to a provider.
//
// The built-in OpenAI and ElevenLabs providers talk to the vendor REST APIs
// over net/http; no vendor SDK is linked.
package stt

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"

	"github.com/langwatch/scenario/go/voice/audio"
)

// Provider transcribes canonical PCM16 audio (24 kHz mono) to text.
type Provider interface {
	Transcribe(ctx context.Context, chunk audio.Chunk) (string, error)
}

// ProviderFunc adapts a function to [Provider].
type ProviderFunc func(ctx context.Context, chunk audio.Chunk) (string, error)

// Transcribe calls f.
func (f ProviderFunc) Transcribe(ctx context.Context, chunk audio.Chunk) (string, error) {
	return f(ctx, chunk)
}

// Factory builds a provider for the model part of a spec ("" when the spec
// names only the provider, meaning its default model).
type Factory func(model string) Provider

// Registry maps provider names to factories. It is safe for concurrent use.
type Registry struct {
	mu        sync.RWMutex
	factories map[string]Factory
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry { return &Registry{factories: map[string]Factory{}} }

// Register installs factory under provider (case-insensitive), replacing
// any previous one.
func (r *Registry) Register(provider string, factory Factory) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.factories[strings.ToLower(provider)] = factory
}

// Providers lists the registered provider names, sorted.
func (r *Registry) Providers() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	names := make([]string, 0, len(r.factories))
	for n := range r.factories {
		names = append(names, n)
	}
	slices.Sort(names)
	return names
}

// Resolve builds the provider for a "provider/model" or bare "provider"
// spec.
func (r *Registry) Resolve(spec string) (Provider, error) {
	name, model, _ := strings.Cut(spec, "/")
	name = strings.ToLower(name)
	r.mu.RLock()
	factory := r.factories[name]
	r.mu.RUnlock()
	if factory == nil {
		known := strings.Join(r.Providers(), ", ")
		if known == "" {
			known = "(none)"
		}
		return nil, fmt.Errorf("unknown STT provider %q (from %q); registered: %s. "+
			"Register one with Register or pass a Provider directly in the run's voice config", name, spec, known)
	}
	return factory(model), nil
}

var (
	defaultOnce     sync.Once
	defaultRegistry *Registry
)

// Default is the process-wide registry with the built-in "openai" and
// "elevenlabs" providers. It is built on first use.
func Default() *Registry {
	defaultOnce.Do(func() {
		r := NewRegistry()
		r.Register("openai", func(model string) Provider { return NewOpenAI(OpenAIOptions{Model: model}) })
		r.Register("elevenlabs", func(string) Provider { return NewElevenLabs(ElevenLabsOptions{}) })
		defaultRegistry = r
	})
	return defaultRegistry
}

// Resolve resolves spec against the [Default] registry.
func Resolve(spec string) (Provider, error) { return Default().Resolve(spec) }

// Register installs a factory in the [Default] registry.
func Register(provider string, factory Factory) { Default().Register(provider, factory) }
