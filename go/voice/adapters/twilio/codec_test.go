package twilio

// Ported from twilio-shared-codec.test.ts. The codec itself lives in
// voice/audio; these pin the behaviour the Twilio wire edge depends on.

import (
	"math"
	"testing"

	"github.com/langwatch/scenario/go/voice/audio"
)

func sinePCM(seconds, freq float64, rate int, amp float64) []byte {
	n := int(math.Floor(seconds * float64(rate)))
	b := make([]byte, 2*n)
	for i := range n {
		audio.PutSample(b, i, int16(jsRound(amp*math.Sin(2*math.Pi*freq*float64(i)/float64(rate)))))
	}
	return b
}

func samples(b []byte) []float64 {
	out := make([]float64, len(b)/2)
	for i := range out {
		out[i] = float64(audio.Sample(b, i))
	}
	return out
}

func rms(s []float64) float64 {
	if len(s) == 0 {
		return 0
	}
	sum := 0.0
	for _, v := range s {
		sum += v * v
	}
	return math.Sqrt(sum / float64(len(s)))
}

func mean(s []float64) float64 {
	sum := 0.0
	for _, v := range s {
		sum += v
	}
	return sum / float64(max(1, len(s)))
}

func TestMulawRoundTripPreservesFidelity(t *testing.T) {
	in := sinePCM(0.05, 440, 8000, 20000)
	mulaw := audio.AppendMulaw(nil, in)
	out := audio.AppendMulawDecoded(nil, mulaw)
	if len(mulaw) != len(in)/2 || len(out) != len(in) {
		t.Fatalf("lengths %d %d", len(mulaw), len(out))
	}
	a, b := samples(in), samples(out)
	maxErr := 0.0
	for i := range a {
		maxErr = math.Max(maxErr, math.Abs(a[i]-b[i]))
	}
	if maxErr > 32768*0.08 {
		t.Fatalf("max error %.0f", maxErr)
	}
	if r := rms(b) / rms(a); r <= 0.9 || r >= 1.1 {
		t.Fatalf("RMS ratio %.3f", r)
	}
}

func TestResample24kTo8kTo24k(t *testing.T) {
	in := sinePCM(0.05, 220, 24000, 20000)
	down := audio.Resample(in, 24000, 8000)
	up := audio.Resample(down, 8000, 24000)
	ni, nd, nu := len(in)/2, len(down)/2, len(up)/2
	if nd < ni/3-1 || nd > (ni+2)/3+1 || nu < 3*nd-1 || nu > 3*nd+1 {
		t.Fatalf("lengths %d -> %d -> %d", ni, nd, nu)
	}
	if r := rms(samples(up)) / rms(samples(in)); r <= 0.85 || r >= 1.15 {
		t.Fatalf("RMS ratio %.3f", r)
	}
	if math.Abs(mean(samples(up))) >= math.Abs(mean(samples(in)))+200 {
		t.Fatal("DC offset introduced")
	}
	if same := audio.Resample(in, 24000, 24000); &same[0] != &in[0] {
		t.Fatal("same-rate resample must be a no-op")
	}
}

func TestMulawEdgeCases(t *testing.T) {
	silence := make([]byte, 160)
	mulaw := audio.AppendMulaw(nil, silence)
	for _, b := range mulaw {
		if b != mulaw[0] {
			t.Fatal("silence encodes to more than one code")
		}
	}
	for _, s := range samples(audio.AppendMulawDecoded(nil, mulaw)) {
		if math.Abs(s) > 1 {
			t.Fatalf("silence decodes to %v", s)
		}
	}
	clip := make([]byte, 4)
	audio.PutSample(clip, 0, 32700)
	audio.PutSample(clip, 1, -32700)
	d := samples(audio.AppendMulawDecoded(nil, audio.AppendMulaw(nil, clip)))
	if d[0] <= 30000 || d[1] >= -30000 {
		t.Fatalf("clipped samples decode to %v", d)
	}
}
