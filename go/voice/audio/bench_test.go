package audio

import "testing"

// One Twilio media frame: 20 ms of µ-law at 8 kHz, or of PCM16 at 24 kHz.
var (
	frameMulaw = make([]byte, 160)
	framePCM   = sinePCM16(0.02, 440, SampleRate, 12000)
)

func BenchmarkMulaw8kFrom24kFrame(b *testing.B) {
	dst := make([]byte, 0, 160)
	b.ReportAllocs()
	b.SetBytes(int64(len(framePCM)))
	for b.Loop() {
		dst = AppendMulaw8k(dst[:0], framePCM)
	}
}

func BenchmarkPCM24kFromMulaw8kFrame(b *testing.B) {
	dst := make([]byte, 0, 960)
	b.ReportAllocs()
	b.SetBytes(int64(len(frameMulaw)))
	for b.Loop() {
		dst = AppendPCM24kFromMulaw8k(dst[:0], frameMulaw)
	}
}

func BenchmarkResample24kTo16kFrame(b *testing.B) {
	dst := make([]byte, 0, 640)
	b.ReportAllocs()
	for b.Loop() {
		dst = AppendResampled(dst[:0], framePCM, 24000, 16000)
	}
}

func BenchmarkRMSFrame(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		_ = RMS(framePCM)
	}
}

func BenchmarkAppendWAV1s(b *testing.B) {
	pcm := make([]byte, 48000)
	dst := make([]byte, 0, len(pcm)+WAVHeaderSize)
	b.ReportAllocs()
	for b.Loop() {
		dst = AppendWAV(dst[:0], pcm)
	}
}

func BenchmarkFFT4096(b *testing.B) {
	re, im := make([]float64, 4096), make([]float64, 4096)
	plan := FFTFor(4096)
	b.ReportAllocs()
	for b.Loop() {
		plan.Forward(re, im)
	}
}
