package effects

import (
	"errors"

	"github.com/langwatch/scenario/go/voice/internal/jsmath"
)

// Defaults matching the JavaScript SDK's parameter defaults.
const (
	DefaultLowVolume    = 0.5
	DefaultHighVolume   = 1.5
	DefaultSpeakingFast = 1.3
	DefaultSpeakingSlow = 0.7
)

// LowVolume scales amplitude down by factor (0 < factor <= 1).
func LowVolume(factor float64) (Effect, error) {
	if factor <= 0 {
		return nil, errors.New("effects: LowVolume factor must be > 0")
	}
	return gain(factor), nil
}

// HighVolume scales amplitude up by factor (>= 1), clipping at the int16
// bounds.
func HighVolume(factor float64) (Effect, error) {
	if factor < 1 {
		return nil, errors.New("effects: HighVolume factor must be >= 1")
	}
	return gain(factor), nil
}

// SpeakingFast time-stretches speech to factor times faster (factor > 1).
// It is a plain resample, so pitch rises with speed.
func SpeakingFast(factor float64) (Effect, error) {
	if factor <= 1 {
		return nil, errors.New("effects: SpeakingFast factor must be > 1")
	}
	return stretch(factor), nil
}

// SpeakingSlow time-stretches speech to factor times the speed
// (factor < 1), with the same pitch trade-off as [SpeakingFast].
func SpeakingSlow(factor float64) (Effect, error) {
	if factor >= 1 {
		return nil, errors.New("effects: SpeakingSlow factor must be < 1")
	}
	return stretch(factor), nil
}

func gain(factor float64) Effect {
	return func(dst, src []byte) []byte {
		n := len(src) / 2
		dst, out := extend(dst, n)
		for i := range n {
			put(out, i, at(src, i)*factor)
		}
		return dst
	}
}

// stretch resamples to len/factor samples by index gather.
func stretch(factor float64) Effect {
	return func(dst, src []byte) []byte {
		n := len(src) / 2
		if n == 0 {
			return passthrough(dst, src)
		}
		newLen := max(1, int(jsmath.Round(float64(n)/factor)))
		dst, out := extend(dst, newLen)
		for i := range newLen {
			copy(out[2*i:2*i+2], src[2*gatherIndex(i, n, newLen):])
		}
		return dst
	}
}
