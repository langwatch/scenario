package audio

import (
	"math"
	"testing"

	"github.com/langwatch/scenario/go/voice/internal/jsmath"
)

// Ported from javascript/src/voice/adapters/__tests__/twilio-shared-codec.test.ts.

func sinePCM16(seconds, freq float64, rate int, amplitude float64) []byte {
	n := int(seconds * float64(rate))
	out := make([]byte, 0, 2*n)
	for i := range n {
		t := float64(i) / float64(rate)
		out = AppendSample(out, int16(jsmath.Round(amplitude*math.Sin(2*math.Pi*freq*t))))
	}
	return out
}

func samplesOf(pcm []byte) []int16 { return AppendSamples(nil, pcm) }

func rmsOf(s []int16) float64 {
	if len(s) == 0 {
		return 0
	}
	var sum float64
	for _, v := range s {
		sum += float64(v) * float64(v)
	}
	return math.Sqrt(sum / float64(len(s)))
}

func meanOf(s []int16) float64 {
	var sum float64
	for _, v := range s {
		sum += float64(v)
	}
	return sum / float64(max(1, len(s)))
}

func TestMulawRoundTripPreservesFidelity(t *testing.T) {
	in := sinePCM16(0.05, 440, TelephonySampleRate, 20000)
	mu := AppendMulaw(nil, in)
	if len(mu) != len(in)/2 {
		t.Fatalf("encoded %d bytes, want %d", len(mu), len(in)/2)
	}
	out := AppendMulawDecoded(nil, mu)
	if len(out) != len(in) {
		t.Fatalf("decoded %d bytes, want %d", len(out), len(in))
	}
	a, b := samplesOf(in), samplesOf(out)
	maxErr := 0.0
	for i := range a {
		maxErr = max(maxErr, math.Abs(float64(b[i])-float64(a[i])))
	}
	if tol := 32768 * 0.08; maxErr > tol {
		t.Errorf("max abs error %v exceeds G.711 tolerance %v", maxErr, tol)
	}
	if r := rmsOf(b) / rmsOf(a); r <= 0.9 || r >= 1.1 {
		t.Errorf("RMS ratio %v outside (0.9, 1.1)", r)
	}
}

func TestSampleRateConversionBothDirections(t *testing.T) {
	in := sinePCM16(0.05, 220, SampleRate, 20000)
	down := Resample(in, SampleRate, TelephonySampleRate)
	up := Resample(down, TelephonySampleRate, SampleRate)
	n, d, u := len(in)/2, len(down)/2, len(up)/2
	if d < n/3-1 || d > (n+2)/3+1 {
		t.Errorf("downsampled to %d samples from %d", d, n)
	}
	if u < 3*d-1 || u > 3*d+1 {
		t.Errorf("upsampled to %d samples from %d", u, d)
	}
	if r := rmsOf(samplesOf(up)) / rmsOf(samplesOf(in)); r <= 0.85 || r >= 1.15 {
		t.Errorf("RMS ratio %v outside (0.85, 1.15)", r)
	}
	if dc := math.Abs(meanOf(samplesOf(up))); dc >= math.Abs(meanOf(samplesOf(in)))+200 {
		t.Errorf("DC offset %v introduced", dc)
	}
}

func TestMulawSilenceEncodesUniformlyAndDecodesToZero(t *testing.T) {
	mu := AppendMulaw(nil, make([]byte, 160))
	if len(mu) != 80 {
		t.Fatalf("encoded %d bytes, want 80", len(mu))
	}
	for _, b := range mu {
		if b != mu[0] {
			t.Fatal("silent input encoded to differing bytes")
		}
	}
	for _, s := range samplesOf(AppendMulawDecoded(nil, mu)) {
		if s < -1 || s > 1 {
			t.Fatalf("silence decoded to %d", s)
		}
	}
}

func TestMulawClipsInsteadOfWrapping(t *testing.T) {
	in := AppendSample(AppendSample(nil, 32700), -32700)
	out := samplesOf(AppendMulawDecoded(nil, AppendMulaw(nil, in)))
	if out[0] <= 30000 || out[1] >= -30000 {
		t.Errorf("saturated samples decoded to %v", out)
	}
}

func TestTelephonyConversionOfEmptyInputIsEmpty(t *testing.T) {
	if got := AppendPCM24kFromMulaw8k(nil, nil); len(got) != 0 {
		t.Errorf("got %d bytes", len(got))
	}
	if got := AppendMulaw8k(nil, nil); len(got) != 0 {
		t.Errorf("got %d bytes", len(got))
	}
}

func TestResampleSameRateReturnsInput(t *testing.T) {
	in := sinePCM16(0.01, 440, 24000, 20000)
	if out := Resample(in, 24000, 24000); &out[0] != &in[0] {
		t.Error("same-rate Resample copied its input")
	}
}

func TestFusedTelephonyMatchesTwoStep(t *testing.T) {
	in := sinePCM16(0.1, 300, SampleRate, 12000)
	twoStep := AppendMulaw(nil, Resample(in, SampleRate, TelephonySampleRate))
	if fused := AppendMulaw8k(nil, in); string(fused) != string(twoStep) {
		t.Error("AppendMulaw8k differs from resample + encode")
	}
	decoded := Resample(AppendMulawDecoded(nil, twoStep), TelephonySampleRate, SampleRate)
	if fused := AppendPCM24kFromMulaw8k(nil, twoStep); string(fused) != string(decoded) {
		t.Error("AppendPCM24kFromMulaw8k differs from decode + resample")
	}
}

func TestAppendHelpersPreservePrefix(t *testing.T) {
	prefix := []byte{9, 9}
	out := AppendMulawDecoded(append([]byte(nil), prefix...), []byte{0xff})
	if out[0] != 9 || out[1] != 9 || len(out) != 4 {
		t.Errorf("prefix not preserved: %v", out)
	}
}
