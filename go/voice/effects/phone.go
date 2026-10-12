package effects

import (
	"math"
	"sync"

	"github.com/langwatch/scenario/go/voice/audio"
)

// Phone-line pass band.
const (
	phoneLowHz  = 300
	phoneHighHz = 3400
)

// PhoneQuality mimics a phone line: an FFT band-pass to 300 Hz – 3.4 kHz
// followed by mild tanh compression.
//
// It reproduces the JavaScript SDK's filter exactly, including that it keeps
// only the positive-frequency half of the spectrum, which halves the
// amplitude of what passes. Results agree with JavaScript to within one
// least-significant bit on rare rounding ties, since the two FFTs sum in a
// different order.
func PhoneQuality() Effect {
	return phoneQuality
}

func phoneQuality(dst, src []byte) []byte {
	n := len(src) / 2
	if n == 0 {
		return passthrough(dst, src)
	}
	size := audio.NextPow2(n)
	buf := getComplex(size)
	defer complexPool.Put(buf)
	re, im := buf.re, buf.im
	for i := range n {
		re[i] = at(src, i)
	}
	clear(re[n:])
	clear(im)

	plan := audio.FFTFor(size)
	plan.Forward(re, im)
	// Bin k sits at k·Nyquist/(size/2) Hz. Every bin from size/2 up reads as
	// above Nyquist and is dropped, as in the JavaScript filter.
	nyquist := float64(sampleRate) / 2
	halfBins := float64(size / 2)
	for k := range size {
		freq := float64(k) * nyquist / halfBins
		if freq < phoneLowHz || freq > phoneHighHz {
			re[k], im[k] = 0, 0
		}
	}
	plan.Inverse(re, im)

	dst, out := extend(dst, n)
	for i := range n {
		v := float64(float32(re[i]))
		put(out, i, math.Tanh(v/16000)*16000)
	}
	return dst
}

// complexBuf is a pair of FFT work arrays.
type complexBuf struct{ re, im []float64 }

var complexPool sync.Pool

func getComplex(size int) *complexBuf {
	if b, ok := complexPool.Get().(*complexBuf); ok && cap(b.re) >= size {
		b.re, b.im = b.re[:size], b.im[:size]
		return b
	}
	return &complexBuf{re: make([]float64, size), im: make([]float64, size)}
}
