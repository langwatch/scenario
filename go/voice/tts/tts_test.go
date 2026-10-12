package tts

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
)

// Ported from javascript/src/voice/__tests__/tts.test.ts.

type spy struct {
	calls atomic.Int32
	last  [2]string
	pcm   []byte
}

func (s *spy) synth(_ context.Context, text, voice string) ([]byte, error) {
	s.calls.Add(1)
	s.last = [2]string{text, voice}
	return s.pcm, nil
}

func newSpy() (*Synthesizer, *spy) {
	sp := &spy{pcm: []byte{1, 2, 3, 4, 5, 6, 7, 8}}
	s := NewSynthesizer(0)
	s.Register("test-tts", sp.synth)
	return s, sp
}

func TestCacheKeyIsTextAndVoice(t *testing.T) {
	ctx := context.Background()
	s, sp := newSpy()
	if !slices.Contains(s.Providers(), "test-tts") {
		t.Fatal("provider not registered")
	}
	s.Synthesize(ctx, "hello world", "test-tts/alice")
	s.Synthesize(ctx, "hello world", "test-tts/alice")
	if sp.calls.Load() != 1 || sp.last != [2]string{"hello world", "alice"} {
		t.Fatalf("calls %d last %v", sp.calls.Load(), sp.last)
	}
	c, _ := s.Synthesize(ctx, "hello world", "test-tts/alice")
	if c.Transcript != "hello world" || sp.calls.Load() != 1 {
		t.Errorf("transcript %q calls %d", c.Transcript, sp.calls.Load())
	}

	s.ClearCache()
	sp.calls.Store(0)
	s.Synthesize(ctx, "same text", "test-tts/alice")
	s.Synthesize(ctx, "same text", "test-tts/bob")
	if sp.calls.Load() != 2 {
		t.Errorf("different voices shared a cache entry")
	}

	s.ClearCache()
	sp.calls.Store(0)
	s.Synthesize(ctx, "hi", "test-tts/alice")
	s.Synthesize(ctx, "bye", "test-tts/alice")
	if sp.calls.Load() != 2 {
		t.Errorf("different texts shared a cache entry")
	}
}

func TestEffectsApplyAfterCacheAndAreNeverBakedIn(t *testing.T) {
	ctx := context.Background()
	s, sp := newSpy()
	raw, _ := s.Synthesize(ctx, "flat", "test-tts/alice")
	boost := func(dst, src []byte) []byte {
		for _, b := range src {
			dst = append(dst, b+1)
		}
		return dst
	}
	boosted, _ := s.Synthesize(ctx, "flat", "test-tts/alice", boost)
	if sp.calls.Load() != 1 || bytes.Equal(boosted.Data, raw.Data) {
		t.Fatalf("calls %d, boosted %v", sp.calls.Load(), boosted.Data)
	}
	reverse := func(dst, src []byte) []byte {
		r := slices.Clone(src)
		slices.Reverse(r)
		return append(dst, r...)
	}
	reversed, _ := s.Synthesize(ctx, "flat", "test-tts/alice", reverse)
	if sp.calls.Load() != 1 || !bytes.Equal(reversed.Data, []byte{8, 7, 6, 5, 4, 3, 2, 1}) {
		t.Errorf("reversed %v from the cached original, calls %d", reversed.Data, sp.calls.Load())
	}
	if again, _ := s.Synthesize(ctx, "flat", "test-tts/alice"); !bytes.Equal(again.Data, sp.pcm) {
		t.Error("an effect leaked into the cached audio")
	}
}

func TestVoiceValidation(t *testing.T) {
	s, _ := newSpy()
	if _, err := s.Synthesize(context.Background(), "hi", "no-slash"); err == nil || !strings.Contains(err.Error(), "provider/name") {
		t.Errorf("err = %v", err)
	}
	if _, err := s.Synthesize(context.Background(), "hi", "definitely-not-registered/x"); err == nil || !strings.Contains(err.Error(), "unknown TTS provider") {
		t.Errorf("err = %v", err)
	}
}

func TestCacheEvictsLeastRecentlyUsed(t *testing.T) {
	ctx := context.Background()
	sp := &spy{pcm: []byte{0, 0}}
	s := NewSynthesizer(2)
	s.Register("p", sp.synth)
	s.Synthesize(ctx, "a", "p/v")
	s.Synthesize(ctx, "b", "p/v")
	s.Synthesize(ctx, "a", "p/v") // touch a
	s.Synthesize(ctx, "c", "p/v") // evicts b
	if s.cache.len() != 2 {
		t.Fatalf("cache holds %d", s.cache.len())
	}
	before := sp.calls.Load()
	s.Synthesize(ctx, "a", "p/v")
	if sp.calls.Load() != before {
		t.Error("recently used entry was evicted")
	}
	s.Synthesize(ctx, "b", "p/v")
	if sp.calls.Load() != before+1 {
		t.Error("least recently used entry survived")
	}
}

func TestOddTrailingByteIsDropped(t *testing.T) {
	sp := &spy{pcm: []byte{1, 2, 3}}
	s := NewSynthesizer(0)
	s.Register("p", sp.synth)
	if c, _ := s.Synthesize(context.Background(), "x", "p/v"); len(c.Data) != 2 {
		t.Errorf("got %d bytes", len(c.Data))
	}
}

func TestOpenAIBackendRequest(t *testing.T) {
	var got map[string]string
	var path, auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, auth = r.URL.Path, r.Header.Get("Authorization")
		json.NewDecoder(r.Body).Decode(&got)
		w.Write([]byte{1, 0, 2, 0, 9})
	}))
	defer srv.Close()
	s := NewSynthesizer(0)
	s.Register("openai", NewOpenAI(OpenAIOptions{APIKey: "sk", BaseURL: srv.URL + "/v1"}).Synthesize)
	c, err := s.Synthesize(context.Background(), "hello", "openai/nova")
	if err != nil {
		t.Fatal(err)
	}
	if path != "/v1/audio/speech" || auth != "Bearer sk" {
		t.Errorf("path %q auth %q", path, auth)
	}
	want := map[string]string{"model": "gpt-4o-mini-tts", "voice": "nova", "input": "hello", "response_format": "pcm"}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
	if !bytes.Equal(c.Data, []byte{1, 0, 2, 0}) {
		t.Errorf("audio %v", c.Data)
	}
}

func TestElevenLabsBackendRequest(t *testing.T) {
	var got map[string]string
	var uri, key string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uri, key = r.URL.RequestURI(), r.Header.Get("xi-api-key")
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &got)
		w.Write(make([]byte, 480))
	}))
	defer srv.Close()
	t.Setenv("ELEVENLABS_BASE_URL", "https://gateway.invalid") // must be ignored
	p := NewElevenLabs(ElevenLabsOptions{APIKey: "xi", BaseURL: srv.URL})
	pcm, err := p.Synthesize(context.Background(), "[laughs] hi", ElevenLabsDefaultVoiceID)
	if err != nil {
		t.Fatal(err)
	}
	if uri != "/v1/text-to-speech/"+ElevenLabsDefaultVoiceID+"?output_format=pcm_24000" || key != "xi" {
		t.Errorf("uri %q key %q", uri, key)
	}
	if got["model_id"] != "eleven_v3" || got["text"] != "[laughs] hi" || len(pcm) != 480 {
		t.Errorf("body %v, %d bytes", got, len(pcm))
	}
	if _, err := NewElevenLabs(ElevenLabsOptions{BaseURL: "https://x.example/v1"}).Synthesize(context.Background(), "a", "b"); err == nil {
		t.Error("base URL with /v1 accepted")
	}
}

func TestDefaultHasBuiltInProviders(t *testing.T) {
	if got := Default().Providers(); !slices.Equal(got, []string{"elevenlabs", "openai"}) {
		t.Errorf("providers %v", got)
	}
}

func BenchmarkSynthesizeCacheHit(b *testing.B) {
	s, _ := newSpy()
	ctx := context.Background()
	s.Synthesize(ctx, "a typical sentence the simulated user says", "test-tts/alice")
	b.ReportAllocs()
	for b.Loop() {
		s.Synthesize(ctx, "a typical sentence the simulated user says", "test-tts/alice")
	}
}
