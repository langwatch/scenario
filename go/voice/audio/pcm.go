package audio

import (
	"encoding/binary"
	"slices"
)

// Sample returns the i-th little-endian PCM16 sample of pcm.
func Sample(pcm []byte, i int) int16 {
	return int16(binary.LittleEndian.Uint16(pcm[2*i:]))
}

// PutSample stores s as the i-th little-endian PCM16 sample of pcm.
func PutSample(pcm []byte, i int, s int16) {
	binary.LittleEndian.PutUint16(pcm[2*i:], uint16(s))
}

// AppendSample appends s to dst as little-endian PCM16.
func AppendSample(dst []byte, s int16) []byte {
	return binary.LittleEndian.AppendUint16(dst, uint16(s))
}

// AppendInt16s appends samples to dst as little-endian PCM16 bytes.
func AppendInt16s(dst []byte, samples []int16) []byte {
	n := len(dst)
	dst = Extend(dst, 2*len(samples))
	out := dst[n:]
	for i, s := range samples {
		binary.LittleEndian.PutUint16(out[2*i:], uint16(s))
	}
	return dst
}

// AppendSamples decodes the whole samples of little-endian pcm and appends
// them to dst. A trailing odd byte is ignored.
func AppendSamples(dst []int16, pcm []byte) []int16 {
	n := len(pcm) / 2
	dst = slices.Grow(dst, n)
	for i := range n {
		dst = append(dst, int16(binary.LittleEndian.Uint16(pcm[2*i:])))
	}
	return dst
}

// Extend grows dst by n bytes and returns it; the new bytes are the caller's
// to overwrite. It reallocates only when dst lacks the capacity.
func Extend(dst []byte, n int) []byte {
	return slices.Grow(dst, n)[:len(dst)+n]
}
