// Package tts turns text into canonical audio (PCM16, 24 kHz, mono).
//
// Voices are litellm-style "provider/name" strings such as "openai/nova" or
// "elevenlabs/<voiceId>". A [Synthesizer] routes them to registered
// backends and caches results on (sha256(text), voice). Audio effects run
// after the cache read and are never baked into cached audio, so one cached
// utterance can be replayed under different effects.
//
// The built-in OpenAI and ElevenLabs backends talk to the vendor REST APIs
// over net/http; no vendor SDK is linked.
package tts

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"

	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/effects"
)

// SynthFunc synthesizes text with the named voice of one provider and
// returns canonical PCM16 bytes.
type SynthFunc func(ctx context.Context, text, voiceName string) ([]byte, error)

// Synthesizer routes voices to providers and caches their output. It is
// safe for concurrent use.
type Synthesizer struct {
	mu        sync.RWMutex
	providers map[string]SynthFunc
	cache     *lru
}

// NewSynthesizer returns a synthesizer with no providers and a cache of
// maxEntries utterances ([DefaultCacheEntries] when maxEntries <= 0).
func NewSynthesizer(maxEntries int) *Synthesizer {
	if maxEntries <= 0 {
		maxEntries = DefaultCacheEntries
	}
	return &Synthesizer{providers: map[string]SynthFunc{}, cache: newLRU(maxEntries)}
}

// Register installs fn as the backend for prefix (case-insensitive).
func (s *Synthesizer) Register(prefix string, fn SynthFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.providers[strings.ToLower(prefix)] = fn
}

// Providers lists the registered prefixes, sorted.
func (s *Synthesizer) Providers() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	names := make([]string, 0, len(s.providers))
	for n := range s.providers {
		names = append(names, n)
	}
	slices.Sort(names)
	return names
}

// ClearCache empties the synthesis cache.
func (s *Synthesizer) ClearCache() { s.cache.clear() }

// Synthesize returns text spoken by voice ("provider/name"), with
// Transcript set to text. A cache hit skips the provider. fx, when given,
// is applied in order to a copy of the cached audio.
//
// Without effects the returned Data is shared with the cache and must be
// treated as read-only.
func (s *Synthesizer) Synthesize(ctx context.Context, text, voice string, fx ...effects.Effect) (audio.Chunk, error) {
	key := keyFor(text, voice)
	pcm, ok := s.cache.get(key)
	if !ok {
		var err error
		if pcm, err = s.synthesizeRaw(ctx, text, voice); err != nil {
			return audio.Chunk{}, err
		}
		s.cache.put(key, pcm)
	}
	if len(fx) > 0 {
		pcm = effects.Apply(pcm, fx...)
	}
	return audio.Chunk{Data: pcm, Transcript: text}, nil
}

func (s *Synthesizer) synthesizeRaw(ctx context.Context, text, voice string) ([]byte, error) {
	provider, name, ok := strings.Cut(voice, "/")
	if !ok {
		return nil, fmt.Errorf("voice string %q must be in 'provider/name' format, e.g. 'openai/nova'", voice)
	}
	provider = strings.ToLower(provider)
	s.mu.RLock()
	fn := s.providers[provider]
	s.mu.RUnlock()
	if fn == nil {
		known := strings.Join(s.Providers(), ", ")
		if known == "" {
			known = "(none)"
		}
		return nil, fmt.Errorf("unknown TTS provider %q; known: %s", provider, known)
	}
	pcm, err := fn(ctx, text, name)
	if err != nil {
		return nil, err
	}
	// A trailing odd byte would break the PCM16 sample invariant and poison
	// the cache; drop it.
	return pcm[:len(pcm)&^1], nil
}

var (
	defaultOnce  sync.Once
	defaultSynth *Synthesizer
)

// Default is the process-wide synthesizer with the built-in "openai" and
// "elevenlabs" backends (credentials from the environment). It is built on
// first use.
func Default() *Synthesizer {
	defaultOnce.Do(func() {
		s := NewSynthesizer(DefaultCacheEntries)
		s.Register("openai", NewOpenAI(OpenAIOptions{}).Synthesize)
		s.Register("elevenlabs", NewElevenLabs(ElevenLabsOptions{}).Synthesize)
		defaultSynth = s
	})
	return defaultSynth
}

// Synthesize synthesizes with the [Default] synthesizer.
func Synthesize(ctx context.Context, text, voice string, fx ...effects.Effect) (audio.Chunk, error) {
	return Default().Synthesize(ctx, text, voice, fx...)
}
