package effects

import (
	"encoding/binary"

	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/internal/jsmath"
)

// sampleRate is the canonical rate every effect works at.
const sampleRate = audio.SampleRate

// at reads the i-th PCM16 sample of pcm as a float64.
func at(pcm []byte, i int) float64 {
	return float64(int16(binary.LittleEndian.Uint16(pcm[2*i:])))
}

// put stores v into the i-th sample of out the way the JavaScript effects
// do: through a Float32Array (single precision), then rounded and clamped
// into an Int16Array.
func put(out []byte, i int, v float64) {
	binary.LittleEndian.PutUint16(out[2*i:], uint16(jsmath.Int16(jsmath.Float32(v))))
}

// putRaw stores an already-integral sample.
func putRaw(out []byte, i int, s int16) {
	binary.LittleEndian.PutUint16(out[2*i:], uint16(s))
}

// whole is src truncated to whole samples.
func whole(src []byte) []byte { return src[:len(src)&^1] }

// passthrough appends src unchanged (whole samples only), for effects that
// are a no-op on this input.
func passthrough(dst, src []byte) []byte { return append(dst, whole(src)...) }

// extend grows dst by n samples and returns dst and the new region.
func extend(dst []byte, n int) ([]byte, []byte) {
	off := len(dst)
	dst = audio.Extend(dst, 2*n)
	return dst, dst[off:]
}

// gatherIndex is the source index the JavaScript linearResample gathers for
// output i: numpy's linspace(0, oldLen-1, newLen) truncated to an integer.
func gatherIndex(i, oldLen, newLen int) int {
	denom := newLen - 1
	if denom == 0 {
		denom = 1
	}
	return min(oldLen-1, i*(oldLen-1)/denom)
}
