package audio

import (
	"encoding/binary"
	"math"
)

// RMS is the root-mean-square energy of little-endian PCM16 samples on the
// int16 scale (0..32768). Empty input has an RMS of 0; a trailing odd byte
// is ignored.
//
// The sum of squares is accumulated as an exact integer, which is also what
// the JavaScript float64 accumulation yields for any realistic chunk length,
// so the result matches it bit for bit.
func RMS(pcm []byte) float64 {
	n := len(pcm) / 2
	if n == 0 {
		return 0
	}
	var sum uint64
	for i := 0; i < 2*n; i += 2 {
		s := int64(int16(binary.LittleEndian.Uint16(pcm[i:])))
		sum += uint64(s * s)
	}
	return math.Sqrt(float64(sum) / float64(n))
}
