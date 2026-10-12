package audio

import (
	"fmt"
	"time"
)

// The canonical internal audio format. Every chunk crossing the voice
// framework boundary is PCM16 little-endian, 24 kHz, mono; adapters convert
// to and from their transport format at the edge.
const (
	SampleRate  = 24000
	Channels    = 1
	SampleWidth = 2 // bytes per sample
)

// Chunk is a piece of audio in the canonical format.
//
// It is a small value type over a byte slice: copying a Chunk never copies
// audio. Data must hold whole samples (an even number of bytes); use
// [NewChunk] to have that checked.
type Chunk struct {
	// Data is PCM16 little-endian, mono, 24 kHz.
	Data []byte
	// Transcript is the text spoken in this chunk, when known (for example
	// from TTS input or streaming STT). Empty means unknown.
	Transcript string
}

// OddLengthError reports PCM16 data that does not hold whole samples, which
// usually means an adapter forwarded a partial transport frame.
type OddLengthError struct{ Len int }

func (e *OddLengthError) Error() string {
	return fmt.Sprintf("audio chunk data length (%d bytes) is not a multiple of %d — not valid PCM16. "+
		"This usually indicates a partial transport frame; adapters must buffer until a complete sample is available.",
		e.Len, SampleWidth)
}

// NewChunk returns a Chunk over data, rejecting partial samples.
func NewChunk(data []byte, transcript string) (Chunk, error) {
	if len(data)%SampleWidth != 0 {
		return Chunk{}, &OddLengthError{Len: len(data)}
	}
	return Chunk{Data: data, Transcript: transcript}, nil
}

// SilentChunk returns a chunk of digital silence lasting seconds.
func SilentChunk(seconds float64) Chunk {
	return Chunk{Data: make([]byte, SamplesFor(seconds)*SampleWidth)}
}

// Samples is the number of whole samples in the chunk.
func (c Chunk) Samples() int { return len(c.Data) / SampleWidth }

// Seconds is the chunk length in seconds.
func (c Chunk) Seconds() float64 { return Seconds(c.Data) }

// Duration is the chunk length as a time.Duration.
func (c Chunk) Duration() time.Duration { return Duration(c.Data) }

// Seconds is the length of canonical PCM16 bytes in seconds.
func Seconds(pcm []byte) float64 {
	return float64(len(pcm)/SampleWidth) / SampleRate
}

// Duration is the length of canonical PCM16 bytes as a time.Duration,
// truncated to the nanosecond.
func Duration(pcm []byte) time.Duration {
	return time.Duration(len(pcm)/SampleWidth) * time.Second / SampleRate
}

// SamplesFor is the number of canonical samples in seconds of audio,
// truncated toward zero as the JavaScript SDK does.
func SamplesFor(seconds float64) int {
	if seconds <= 0 {
		return 0
	}
	return int(seconds * SampleRate)
}

// BytesFor is the canonical PCM16 byte length of d, truncated to whole
// samples.
func BytesFor(d time.Duration) int {
	if d <= 0 {
		return 0
	}
	return int(d*SampleRate/time.Second) * SampleWidth
}
