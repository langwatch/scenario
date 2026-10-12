package effects

import (
	_ "embed" // bundled noise samples
	"fmt"
	"os"
	"sync"
	"unsafe"

	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/internal/jsmath"
)

// The bundled ambience samples: 3 s each, 24 kHz mono PCM16, CC0 (see
// assets/noise/LICENSES.md). They are embedded as strings, which live in
// read-only data: nothing is copied or decoded until an effect asks for one.
var (
	//go:embed assets/noise/cafe.wav
	cafeWAV string
	//go:embed assets/noise/street.wav
	streetWAV string
	//go:embed assets/noise/office.wav
	officeWAV string
	//go:embed assets/noise/airport.wav
	airportWAV string
	//go:embed assets/noise/babble.wav
	babbleWAV string
)

// Background-noise presets accepted by [BackgroundNoise].
const (
	Cafe    = "cafe"
	Street  = "street"
	Office  = "office"
	Airport = "airport"
)

// asset is one bundled sample, parsed on first use. Assets are statically
// initialized (no init-time code). The embedded string is read-only and
// effects only ever read samples, so the parsed PCM aliases it.
type asset struct {
	wav  *string
	once sync.Once
	pcm  []byte
	err  error
}

func (a *asset) samples() ([]byte, error) {
	a.once.Do(func() {
		b := unsafe.Slice(unsafe.StringData(*a.wav), len(*a.wav))
		a.pcm, a.err = toCanonical(b)
	})
	return a.pcm, a.err
}

var (
	cafeAsset    = asset{wav: &cafeWAV}
	streetAsset  = asset{wav: &streetWAV}
	officeAsset  = asset{wav: &officeWAV}
	airportAsset = asset{wav: &airportWAV}
	babbleAsset  = asset{wav: &babbleWAV}
)

// presetAsset returns the bundled background preset called name, or nil.
func presetAsset(name string) *asset {
	switch name {
	case Cafe:
		return &cafeAsset
	case Street:
		return &streetAsset
	case Office:
		return &officeAsset
	case Airport:
		return &airportAsset
	}
	return nil
}

// loadWAVFile reads a user-supplied WAV and converts it to canonical PCM16.
func loadWAVFile(path string) ([]byte, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	pcm, err := toCanonical(b)
	if err != nil {
		return nil, fmt.Errorf("effects: %s: %w", path, err)
	}
	return pcm, nil
}

// toCanonical converts a 16-bit PCM WAV to canonical PCM16 the way the
// JavaScript SDK's wavToInt16 does: channels averaged (rounded), then an
// index-gather resample to 24 kHz. Canonical input is returned as a view of
// b without copying.
func toCanonical(b []byte) ([]byte, error) {
	w, err := audio.ParseWAV(b)
	if err != nil {
		return nil, err
	}
	if w.Format.BitsPerSample != 16 {
		return nil, fmt.Errorf("only 16-bit PCM WAV is supported, got %d-bit", w.Format.BitsPerSample)
	}
	ch := max(1, w.Format.Channels)
	data := whole(w.Data)
	if ch == 1 && w.Format.SampleRate == sampleRate {
		return data, nil
	}
	frames := len(data) / 2 / ch
	mono := make([]byte, 2*frames)
	for i := range frames {
		sum := 0.0
		for c := range ch {
			sum += at(data, i*ch+c)
		}
		putRaw(mono, i, int16(jsmath.Round(sum/float64(ch))))
	}
	if w.Format.SampleRate == sampleRate || frames == 0 {
		return mono, nil
	}
	newLen := max(1, int(jsmath.Round(float64(frames)*sampleRate/float64(w.Format.SampleRate))))
	out := make([]byte, 2*newLen)
	for i := range newLen {
		copy(out[2*i:2*i+2], mono[2*gatherIndex(i, frames, newLen):])
	}
	return out, nil
}
