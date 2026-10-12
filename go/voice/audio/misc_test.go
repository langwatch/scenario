package audio

import (
	"errors"
	"math"
	"math/cmplx"
	"testing"
	"time"
)

func TestNewChunkRejectsPartialSamples(t *testing.T) {
	_, err := NewChunk([]byte{1, 2, 3}, "")
	var odd *OddLengthError
	if !errors.As(err, &odd) || odd.Len != 3 {
		t.Fatalf("err = %v", err)
	}
	if _, err := NewChunk([]byte{1, 2}, "hi"); err != nil {
		t.Fatal(err)
	}
}

func TestChunkDurations(t *testing.T) {
	c := SilentChunk(0.5)
	if c.Samples() != 12000 || c.Seconds() != 0.5 || c.Duration() != 500*time.Millisecond {
		t.Errorf("samples %d seconds %v duration %v", c.Samples(), c.Seconds(), c.Duration())
	}
	if BytesFor(20*time.Millisecond) != 960 {
		t.Errorf("BytesFor(20ms) = %d", BytesFor(20*time.Millisecond))
	}
	if (Chunk{}).Seconds() != 0 || len(SilentChunk(-1).Data) != 0 {
		t.Error("empty chunk has non-zero length")
	}
}

func TestRMS(t *testing.T) {
	// From twilio-speech-gate.test.ts: an alternating ±A tone has RMS A.
	var pcm []byte
	for i := range 2400 {
		s := int16(1380)
		if i%2 == 1 {
			s = -1380
		}
		pcm = AppendSample(pcm, s)
	}
	if got := RMS(pcm); math.Abs(got-1380) > 0.5 {
		t.Errorf("RMS = %v", got)
	}
	if RMS(nil) != 0 || RMS([]byte{1}) != 0 {
		t.Error("RMS of empty input is not 0")
	}
}

func TestFFTMatchesDFT(t *testing.T) {
	const n = 16
	re, im := make([]float64, n), make([]float64, n)
	x := make([]complex128, n)
	for i := range n {
		re[i] = math.Sin(float64(i)) * 100
		im[i] = float64(i % 3)
		x[i] = complex(re[i], im[i])
	}
	FFTFor(n).Forward(re, im)
	for k := range n {
		var want complex128
		for j := range n {
			want += x[j] * cmplx.Exp(complex(0, -2*math.Pi*float64(j*k)/n))
		}
		if cmplx.Abs(complex(re[k], im[k])-want) > 1e-9 {
			t.Fatalf("bin %d = %v, want %v", k, complex(re[k], im[k]), want)
		}
	}
	FFTFor(n).Inverse(re, im)
	for i := range n {
		if cmplx.Abs(complex(re[i], im[i])-x[i]) > 1e-9 {
			t.Fatalf("inverse sample %d = %v, want %v", i, complex(re[i], im[i]), x[i])
		}
	}
}

func TestNextPow2(t *testing.T) {
	for in, want := range map[int]int{0: 1, 1: 1, 2: 2, 3: 4, 1000: 1024, 1024: 1024} {
		if got := NextPow2(in); got != want {
			t.Errorf("NextPow2(%d) = %d", in, got)
		}
	}
}
