package ffmpeg

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/langwatch/scenario/go/voice/audio"
)

// isURLLike reports whether s starts with a URL scheme ("http://",
// "file://", ...): a letter, then letters, digits, "+", "-" or ".", then
// "://".
func isURLLike(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z':
		case i > 0 && (c >= '0' && c <= '9' || c == '+' || c == '-' || c == '.'):
		case i > 0 && c == ':':
			return strings.HasPrefix(s[i:], "://")
		default:
			return false
		}
	}
	return false
}

// decodeArgs ask for canonical PCM16 (s16le, mono, 24 kHz) on stdout.
var decodeArgs = [...]string{"-f", "s16le", "-ac", "1", "-ar", "24000", "pipe:1"}

// DecodeFile loads the audio file at path as canonical PCM16. A 16-bit PCM
// WAV is decoded natively; anything else goes through ffmpeg.
//
// URL-like paths are refused, so audio is never fetched over the network on
// the caller's behalf, not even for file:// URIs.
func DecodeFile(ctx context.Context, path string) ([]byte, error) {
	if isURLLike(path) {
		return nil, fmt.Errorf("refusing URL-like audio input %q: pass a filesystem path (no scheme) or pre-load "+
			"the audio as bytes; the SDK never issues outbound requests for audio assets", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if pcm, ok := decodeWAV(data); ok {
		return pcm, nil
	}
	return run(ctx, nil, append([]string{"-i", path}, decodeArgs[:]...)...)
}

// DecodeBytes decodes encoded audio (any container ffmpeg reads) to
// canonical PCM16. A 16-bit PCM WAV is decoded natively; the result may then
// alias data.
func DecodeBytes(ctx context.Context, data []byte) ([]byte, error) {
	if pcm, ok := decodeWAV(data); ok {
		return pcm, nil
	}
	return run(ctx, data, append([]string{"-i", "pipe:0"}, decodeArgs[:]...)...)
}

// decodeWAV converts a 16-bit PCM WAV to canonical PCM16 without ffmpeg:
// channels are averaged and the rate converted by linear interpolation. ok
// is false for anything else, which is left to ffmpeg.
func decodeWAV(data []byte) (pcm []byte, ok bool) {
	w, err := audio.ParseWAV(data)
	if err != nil || w.Format.BitsPerSample != 16 || w.Format.Channels < 1 {
		return nil, false
	}
	samples := w.Data[:len(w.Data)&^1]
	if ch := w.Format.Channels; ch > 1 {
		samples = downmix(samples, ch)
	}
	return audio.Resample(samples, w.Format.SampleRate, audio.SampleRate), true
}

// downmix averages interleaved PCM16 channels to mono.
func downmix(pcm []byte, channels int) []byte {
	frames := len(pcm) / 2 / channels
	out := make([]byte, 2*frames)
	for i := range frames {
		sum := 0
		for c := range channels {
			sum += int(audio.Sample(pcm, i*channels+c))
		}
		audio.PutSample(out, i, int16(sum/channels))
	}
	return out
}
