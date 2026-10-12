package effects

import (
	"fmt"
	"strings"
)

// Defaults matching the JavaScript SDK's parameter defaults.
const (
	DefaultNoiseVolume     = 0.3  // BackgroundNoise, MultipleVoices
	DefaultStaticIntensity = 0.05 // Static
)

// BackgroundNoise overlays looping ambience at volume (a gain on the
// sample). presetOrPath is a preset ([Cafe], [Street], [Office], [Airport])
// or a path to a 16-bit PCM WAV, recognised by containing a path separator
// or ending in ".wav". Any other string is an error.
func BackgroundNoise(presetOrPath string, volume float64) (Effect, error) {
	if a := presetAsset(presetOrPath); a != nil {
		sample, err := a.samples()
		if err != nil {
			return nil, fmt.Errorf("effects: bundled preset %q: %w", presetOrPath, err)
		}
		return overlay(sample, volume), nil
	}
	if !looksLikePath(presetOrPath) {
		return nil, fmt.Errorf("effects: background noise preset %q is not one of [%s %s %s %s]; "+
			"to load a custom WAV pass a path containing a separator or ending with .wav",
			presetOrPath, Airport, Cafe, Office, Street)
	}
	sample, err := loadWAVFile(presetOrPath)
	if err != nil {
		return nil, err
	}
	return overlay(sample, volume), nil
}

// MultipleVoices mixes in the bundled babble of overlapping talkers at
// volume, simulating conversation in the background.
func MultipleVoices(volume float64) Effect {
	sample, err := babbleAsset.samples()
	if err != nil {
		// The bundled asset is fixed at build time; a failure is a build bug.
		panic(fmt.Sprintf("effects: bundled babble sample: %v", err))
	}
	return overlay(sample, volume)
}

// MultipleVoicesFrom mixes the background speech in the WAV file at path.
func MultipleVoicesFrom(path string, volume float64) (Effect, error) {
	sample, err := loadWAVFile(path)
	if err != nil {
		return nil, err
	}
	return overlay(sample, volume), nil
}

// Static overlays uniform white noise at intensity (a fraction of full
// scale).
func Static(intensity float64, opts ...Option) Effect {
	rnd := newRandom(opts)
	return func(dst, src []byte) []byte {
		n := len(src) / 2
		if n == 0 {
			return passthrough(dst, src)
		}
		dst, out := extend(dst, n)
		rnd.draw(func(next func() float64) {
			for i := range n {
				noise := float64(float64(float64((next()-0.5)*2)*32767) * intensity)
				put(out, i, at(src, i)+noise)
			}
		})
		return dst
	}
}

// overlay mixes sample (looped) into the signal at volume.
func overlay(sample []byte, volume float64) Effect {
	loop := len(sample) / 2
	return func(dst, src []byte) []byte {
		n := len(src) / 2
		if loop == 0 || n == 0 {
			return passthrough(dst, src)
		}
		dst, out := extend(dst, n)
		j := 0
		for i := range n {
			put(out, i, at(src, i)+float64(at(sample, j)*volume))
			if j++; j == loop {
				j = 0
			}
		}
		return dst
	}
}

func looksLikePath(s string) bool {
	return strings.ContainsAny(s, `/\`) || strings.HasSuffix(strings.ToLower(s), ".wav")
}
