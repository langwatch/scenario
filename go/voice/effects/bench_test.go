package effects

import "testing"

// Effects run once per synthesized utterance; 1 s of audio is a typical
// turn fragment.
func benchEffect(b *testing.B, fx Effect) {
	in := make([]byte, 48000)
	for i := range in {
		in[i] = byte(i * 31)
	}
	dst := fx(nil, in)
	b.ReportAllocs()
	b.SetBytes(int64(len(in)))
	for b.Loop() {
		dst = fx(dst[:0], in)
	}
}

func BenchmarkBackgroundNoise1s(b *testing.B) { benchEffect(b, Must(BackgroundNoise(Cafe, 0.3))) }
func BenchmarkPhoneQuality1s(b *testing.B)    { benchEffect(b, PhoneQuality()) }
func BenchmarkLowQuality1s(b *testing.B)      { benchEffect(b, LowQuality(8000)) }
func BenchmarkEcho1s(b *testing.B)            { benchEffect(b, Echo(200, 0.5)) }
func BenchmarkStatic1s(b *testing.B)          { benchEffect(b, Static(0.05)) }
func BenchmarkChain3x1s(b *testing.B) {
	benchEffect(b, Chain(Must(BackgroundNoise(Cafe, 0.3)), PhoneQuality(), Must(PacketLoss(0.05, 20))))
}
