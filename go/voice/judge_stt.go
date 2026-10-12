package voice

import (
	"context"
	"fmt"
	"hash/maphash"
	"log"
	"slices"
	"sync"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice/stt"
)

// TranscriptCache remembers transcripts by audio payload, so the same chunk
// re-sent across Proceed turns is transcribed once. An empty transcript is
// a remembered miss.
type TranscriptCache interface {
	CachedTranscript(audio []byte) (string, bool)
	CacheTranscript(audio []byte, text string)
}

// TranscribeMessagesOptions tune [TranscribeAudioMessages].
type TranscribeMessagesOptions struct {
	// IncludeAudio keeps the audio parts next to the transcript (an
	// audio-capable model); otherwise they are dropped.
	IncludeAudio bool
	// Cache, when set, is consulted before and filled after each STT call.
	Cache TranscriptCache
	// Warn receives warnings; log.Print when nil.
	Warn func(string)
}

// TranscribeAudioMessages is the shared STT pre-pass of the judge and the
// user simulator: every message carrying audio gets its spoken words as a
// leading text part (its own text part when it has one, else a
// transcription), and keeps or drops its audio parts. Other messages pass
// through. The input is not modified. STT failures are warned about and the
// message continues without a transcript.
func TranscribeAudioMessages(ctx context.Context, msgs []scenario.Message, provider stt.Provider, opts TranscribeMessagesOptions) []scenario.Message {
	warn := opts.Warn
	if warn == nil {
		warn = func(s string) { log.Print(s) }
	}
	out := slices.Clone(msgs)
	var (
		wg     sync.WaitGroup
		warnMu sync.Mutex
		slots  = make(chan struct{}, maxConcurrentTranscriptions)
	)
	for i, m := range msgs {
		if !slices.ContainsFunc(m.Parts, isAudioPart) {
			continue
		}
		if hasNonEmptyText(m) {
			out[i] = rebuildAudioMessage(m, "", opts.IncludeAudio)
			continue
		}
		chunk, ok := ExtractAudio(m)
		if !ok {
			out[i] = rebuildAudioMessage(m, "", opts.IncludeAudio)
			continue
		}
		if opts.Cache != nil {
			if text, hit := opts.Cache.CachedTranscript(chunk.Data); hit {
				out[i] = rebuildAudioMessage(m, text, opts.IncludeAudio)
				continue
			}
		}
		wg.Add(1)
		slots <- struct{}{}
		go func() {
			defer func() { <-slots; wg.Done() }()
			text, err := provider.Transcribe(ctx, AudioChunk{Data: chunk.Data})
			if opts.Cache != nil {
				// Failures are remembered too, so an outage is not retried for
				// the same chunk on every later turn.
				opts.Cache.CacheTranscript(chunk.Data, text)
			}
			if err != nil {
				warnMu.Lock()
				warn(fmt.Sprintf("scenario.voice.judge-stt: STT failed for a %s audio message; dropping audio and continuing text-only: %v", m.Role, err))
				warnMu.Unlock()
				text = ""
			}
			out[i] = rebuildAudioMessage(m, text, opts.IncludeAudio)
		}()
	}
	wg.Wait()
	return out
}

// rebuildAudioMessage prepends transcript (when non-empty) and keeps the
// audio parts only with includeAudio.
func rebuildAudioMessage(m scenario.Message, transcript string, includeAudio bool) scenario.Message {
	parts := make([]scenario.Part, 0, len(m.Parts)+1)
	if transcript != "" {
		parts = append(parts, scenario.TextPart(transcript))
	}
	for _, p := range m.Parts {
		if isAudioPart(p) && !includeAudio {
			continue
		}
		parts = append(parts, p)
	}
	m.Parts = parts
	return m
}

type audioKey struct {
	hash uint64
	n    int
}

func (s *Session) audioKey(audio []byte) audioKey {
	return audioKey{hash: maphash.Bytes(s.seed, audio), n: len(audio)}
}

// CachedTranscript implements TranscriptCache for the run.
func (s *Session) CachedTranscript(audio []byte) (string, bool) {
	v, ok := s.sttCache.Load(s.audioKey(audio))
	if !ok {
		return "", false
	}
	return v.(string), true
}

// CacheTranscript implements TranscriptCache for the run.
func (s *Session) CacheTranscript(audio []byte, text string) {
	s.sttCache.Store(s.audioKey(audio), text)
}
