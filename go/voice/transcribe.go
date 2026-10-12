package voice

import (
	"context"
	"fmt"
	"log"
	"sync"

	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/stt"
)

// maxConcurrentTranscriptions bounds the STT requests TranscribeSegments
// keeps in flight.
const maxConcurrentTranscriptions = 8

// TranscribeOptions tune [TranscribeSegments].
type TranscribeOptions struct {
	// Overwrite re-transcribes segments that already have a transcript
	// (for example to replace adapter-side STT with another provider).
	Overwrite bool
	// Warn receives warnings; log.Print when nil.
	Warn func(string)
}

// TranscribeSegments fills in missing transcripts on rec's segments, in
// place, using provider. It is best effort and never fails: with a nil
// provider it warns and returns, and a segment whose transcription fails is
// warned about and left without a transcript. Segments without audio are
// skipped. Requests run concurrently.
func TranscribeSegments(ctx context.Context, rec *VoiceRecording, provider stt.Provider, opts TranscribeOptions) {
	if rec == nil || len(rec.Segments) == 0 {
		return
	}
	warn := opts.Warn
	if warn == nil {
		warn = func(s string) { log.Print(s) }
	}
	if provider == nil {
		warn("scenario.voice.transcribe: no STT provider configured; agent transcripts will remain empty. " +
			"Pass a provider, or set one in the run's voice config, to enable.")
		return
	}
	var (
		wg     sync.WaitGroup
		warnMu sync.Mutex
		slots  = make(chan struct{}, maxConcurrentTranscriptions)
	)
	for i := range rec.Segments {
		seg := &rec.Segments[i]
		if len(seg.Audio) == 0 || (!opts.Overwrite && seg.Transcript != "") {
			continue
		}
		wg.Add(1)
		slots <- struct{}{}
		go func() {
			defer func() { <-slots; wg.Done() }()
			text, err := provider.Transcribe(ctx, audio.Chunk{Data: seg.Audio})
			if err != nil {
				warnMu.Lock()
				defer warnMu.Unlock()
				warn(fmt.Sprintf("scenario.voice.transcribe: STT failed for %s segment at %.2fs: %v",
					seg.Speaker, seg.StartTime, err))
				return
			}
			seg.Transcript = text
		}()
	}
	wg.Wait()
}
