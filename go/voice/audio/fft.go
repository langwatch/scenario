package audio

import (
	"fmt"
	"math"
	"math/bits"
	"sync"
)

// FFT is an in-place iterative radix-2 complex FFT of one power-of-two size.
// Its twiddle and bit-reversal tables are built once per size; an FFT is
// safe for concurrent use.
type FFT struct {
	n        int
	cos, sin []float64 // twiddles for k in [0, n/2)
	rev      []uint32  // bit-reversal permutation
}

var fftPlans sync.Map // int -> *FFT

// FFTFor returns the cached FFT plan for size n, which must be a power of
// two. Plans are built on first request, never at program start.
func FFTFor(n int) *FFT {
	if p, ok := fftPlans.Load(n); ok {
		return p.(*FFT)
	}
	p, _ := fftPlans.LoadOrStore(n, newFFT(n))
	return p.(*FFT)
}

func newFFT(n int) *FFT {
	if n < 1 || n&(n-1) != 0 {
		panic(fmt.Sprintf("audio: FFT size %d is not a power of two", n))
	}
	f := &FFT{n: n, cos: make([]float64, n/2), sin: make([]float64, n/2), rev: make([]uint32, n)}
	for k := range n / 2 {
		a := -2 * math.Pi * float64(k) / float64(n)
		f.cos[k], f.sin[k] = math.Cos(a), math.Sin(a)
	}
	shift := 32 - bits.Len(uint(n-1))
	for i := range n {
		if n > 1 {
			f.rev[i] = bits.Reverse32(uint32(i)) >> shift
		}
	}
	return f
}

// Len is the transform size.
func (f *FFT) Len() int { return f.n }

// Forward transforms (re, im) in place. Both slices must have length Len().
func (f *FFT) Forward(re, im []float64) { f.transform(re, im, false) }

// Inverse applies the inverse transform in place, scaled by 1/n so that
// Inverse(Forward(x)) == x.
func (f *FFT) Inverse(re, im []float64) {
	f.transform(re, im, true)
	scale := 1 / float64(f.n)
	for i := range re {
		re[i] *= scale
		im[i] *= scale
	}
}

func (f *FFT) transform(re, im []float64, inverse bool) {
	n := f.n
	if len(re) != n || len(im) != n {
		panic("audio: FFT input length mismatch")
	}
	for i, j := range f.rev {
		if int(j) > i {
			re[i], re[j] = re[j], re[i]
			im[i], im[j] = im[j], im[i]
		}
	}
	sign := 1.0
	if inverse {
		sign = -1
	}
	for size := 2; size <= n; size <<= 1 {
		half, step := size/2, n/size
		for start := 0; start < n; start += size {
			for k := range half {
				wr, wi := f.cos[k*step], sign*f.sin[k*step]
				a, b := start+k, start+k+half
				tr := re[b]*wr - im[b]*wi
				ti := re[b]*wi + im[b]*wr
				re[b], im[b] = re[a]-tr, im[a]-ti
				re[a] += tr
				im[a] += ti
			}
		}
	}
}

// NextPow2 is the smallest power of two >= n (1 for n <= 1).
func NextPow2(n int) int {
	if n <= 1 {
		return 1
	}
	return 1 << bits.Len(uint(n-1))
}
