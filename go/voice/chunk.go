package voice

import "github.com/langwatch/scenario/go/voice/audio"

// AudioChunk is the canonical internal audio representation: PCM16
// little-endian, 24 kHz, mono. It is defined in the audio subpackage so the
// stt, tts, vad and adapter packages can share it without importing this
// one.
type AudioChunk = audio.Chunk

// The canonical format, re-exported from the audio subpackage.
const (
	PCM16SampleRate  = audio.SampleRate
	PCM16Channels    = audio.Channels
	PCM16SampleWidth = audio.SampleWidth
)

// NewAudioChunk returns an AudioChunk over data, rejecting data that does
// not hold whole PCM16 samples.
func NewAudioChunk(data []byte, transcript string) (AudioChunk, error) {
	return audio.NewChunk(data, transcript)
}

// SilentChunk returns a chunk of digital silence lasting seconds.
func SilentChunk(seconds float64) AudioChunk { return audio.SilentChunk(seconds) }
