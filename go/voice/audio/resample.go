package audio

import (
	"encoding/binary"

	"github.com/langwatch/scenario/go/voice/internal/jsmath"
)

// Resample converts mono little-endian PCM16 from fromRate to toRate by
// stateless linear interpolation between adjacent samples, mirroring
// Python's audioop.ratecv for a single batch and the JavaScript SDK's
// resamplePcm16 sample for sample.
//
// Same-rate and empty input are returned unchanged (the same slice), so a
// no-op call costs nothing. Otherwise a new slice is allocated; use
// [AppendResampled] to reuse a buffer.
func Resample(pcm []byte, fromRate, toRate int) []byte {
	if len(pcm) == 0 || fromRate == toRate {
		return pcm
	}
	return AppendResampled(nil, pcm, fromRate, toRate)
}

// AppendResampled appends pcm resampled from fromRate to toRate to dst. It
// follows [Resample]'s math; a same-rate call appends a copy of pcm.
func AppendResampled(dst, pcm []byte, fromRate, toRate int) []byte {
	in := len(pcm) / 2
	if in == 0 {
		return dst
	}
	if fromRate == toRate {
		return append(dst, pcm[:2*in]...)
	}
	if fromRate%toRate == 0 {
		return appendDecimated(dst, pcm, fromRate/toRate, resampledLen(in, fromRate, toRate))
	}
	return appendInterpolated(dst, pcm, in, fromRate, toRate)
}

// resampledLen is the output sample count: round(in * to / from), at least 1.
func resampledLen(in, fromRate, toRate int) int {
	n := int(jsmath.Round(float64(in) * float64(toRate) / float64(fromRate)))
	return max(1, n)
}

// appendDecimated handles integral down-sampling ratios, where every
// interpolation point lands exactly on an input sample.
func appendDecimated(dst, pcm []byte, step, out int) []byte {
	off := len(dst)
	dst = Extend(dst, 2*out)
	o := dst[off:]
	for i := range out {
		copy(o[2*i:2*i+2], pcm[2*step*i:])
	}
	return dst
}

// The general linear interpolator, specialised per input encoding so the
// per-sample read inlines. For output sample i it reads input samples
// i0 = floor(i·ratio) and i1 = min(i0+1, last) and rounds the line between
// them, exactly as the JavaScript resamplePcm16 does.

// appendInterpolated interpolates little-endian PCM16 input.
func appendInterpolated(dst, pcm []byte, in, fromRate, toRate int) []byte {
	out := resampledLen(in, fromRate, toRate)
	ratio := float64(fromRate) / float64(toRate)
	dst, o := extendSamples(dst, out)
	last := in - 1
	for i := range out {
		pos := float64(float64(i) * ratio)
		i0 := int(pos) // pos >= 0, so truncation is floor
		i1 := min(i0+1, last)
		s0 := int16(binary.LittleEndian.Uint16(pcm[2*i0:]))
		s1 := int16(binary.LittleEndian.Uint16(pcm[2*i1:]))
		binary.LittleEndian.PutUint16(o[2*i:], uint16(lerp(s0, s1, pos-float64(i0))))
	}
	return dst
}

// appendInterpolatedMulaw interpolates µ-law input, decoding as it reads.
func appendInterpolatedMulaw(dst, mulaw []byte, fromRate, toRate int) []byte {
	dec := &mulawLUT().decode
	in := len(mulaw)
	out := resampledLen(in, fromRate, toRate)
	ratio := float64(fromRate) / float64(toRate)
	dst, o := extendSamples(dst, out)
	last := in - 1
	for i := range out {
		pos := float64(float64(i) * ratio)
		i0 := int(pos)
		i1 := min(i0+1, last)
		binary.LittleEndian.PutUint16(o[2*i:], uint16(lerp(dec[mulaw[i0]], dec[mulaw[i1]], pos-float64(i0))))
	}
	return dst
}

// lerp rounds s0 + (s1-s0)·frac with JavaScript's Math.round. The explicit
// float64 conversion stops the compiler fusing the multiply-add (FMA), which
// would round differently from JavaScript on arm64. The result lies between
// s0 and s1, so it always fits an int16.
func lerp(s0, s1 int16, frac float64) int16 {
	a, b := float64(s0), float64(s1)
	return int16(jsmath.Round(a + float64((b-a)*frac)))
}

// extendSamples grows dst by n PCM16 samples and returns it with the new
// region.
func extendSamples(dst []byte, n int) ([]byte, []byte) {
	off := len(dst)
	dst = Extend(dst, 2*n)
	return dst, dst[off:]
}
