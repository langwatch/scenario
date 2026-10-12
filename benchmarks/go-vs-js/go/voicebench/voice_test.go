// Package voicebench measures the Go voice audio paths per 20 ms frame,
// with the same inputs as js/voice.mjs. Run with:
//
//	go test -run '^$' -bench . -benchmem -count 5 ./voicebench
package voicebench

import (
	"math"
	"testing"

	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/effects"
)

// sine returns PCM16 little-endian of a 440 Hz tone, amplitude 12000, the
// same generator as js/voice.mjs: round(12000·sin(2π·440·i/rate)).
func sine(seconds float64, rate int) []byte {
	n := int(seconds * float64(rate))
	out := make([]byte, 2*n)
	for i := range n {
		s := int16(math.Round(12000 * math.Sin(2*math.Pi*440*float64(i)/float64(rate))))
		out[2*i] = byte(s)
		out[2*i+1] = byte(uint16(s) >> 8)
	}
	return out
}

var (
	pcm24kFrame = sine(0.02, 24000)                  // 960 bytes
	pcm8kFrame  = sine(0.02, 8000)                   // 320 bytes
	mulawFrame  = audio.AppendMulaw(nil, pcm8kFrame) // 160 bytes
	pcm24k1s    = sine(1, 24000)                     // 48000 bytes
	sinkLen     int                                  // keeps results alive
)

// The Append* functions write into a reused buffer, as the Go adapters do
// on their hot path; the JS functions allocate a new Uint8Array per call.

func BenchmarkVoiceMulawEncodeFrame(b *testing.B) {
	dst := make([]byte, 0, 160)
	b.ReportAllocs()
	for b.Loop() {
		dst = audio.AppendMulaw(dst[:0], pcm8kFrame)
	}
	sinkLen += len(dst)
}

func BenchmarkVoiceMulawDecodeFrame(b *testing.B) {
	dst := make([]byte, 0, 320)
	b.ReportAllocs()
	for b.Loop() {
		dst = audio.AppendMulawDecoded(dst[:0], mulawFrame)
	}
	sinkLen += len(dst)
}

func BenchmarkVoiceResample24kTo8kFrame(b *testing.B) {
	dst := make([]byte, 0, 320)
	b.ReportAllocs()
	for b.Loop() {
		dst = audio.AppendResampled(dst[:0], pcm24kFrame, 24000, 8000)
	}
	sinkLen += len(dst)
}

func BenchmarkVoiceResample8kTo24kFrame(b *testing.B) {
	dst := make([]byte, 0, 960)
	b.ReportAllocs()
	for b.Loop() {
		dst = audio.AppendResampled(dst[:0], pcm8kFrame, 8000, 24000)
	}
	sinkLen += len(dst)
}

// BenchmarkVoiceTelephonyOutFrame is PCM16 24 kHz to µ-law 8 kHz, the
// outbound Twilio path (JS pcm16At24kToMulaw8k).
func BenchmarkVoiceTelephonyOutFrame(b *testing.B) {
	dst := make([]byte, 0, 160)
	b.ReportAllocs()
	for b.Loop() {
		dst = audio.AppendMulaw8k(dst[:0], pcm24kFrame)
	}
	sinkLen += len(dst)
}

// BenchmarkVoiceTelephonyInFrame is µ-law 8 kHz to PCM16 24 kHz, the
// inbound Twilio path (JS mulaw8kToPcm16At24k).
func BenchmarkVoiceTelephonyInFrame(b *testing.B) {
	dst := make([]byte, 0, 960)
	b.ReportAllocs()
	for b.Loop() {
		dst = audio.AppendPCM24kFromMulaw8k(dst[:0], mulawFrame)
	}
	sinkLen += len(dst)
}

// chain is background noise (cafe, 0.3), phone quality and packet loss
// (5 %, 20 ms windows), the same chain as js/voice.mjs.
func chain(b *testing.B) effects.Effect {
	noise, err := effects.BackgroundNoise(effects.Cafe, 0.3)
	if err != nil {
		b.Fatal(err)
	}
	loss, err := effects.PacketLoss(0.05, 20)
	if err != nil {
		b.Fatal(err)
	}
	return effects.Chain(noise, effects.PhoneQuality(), loss)
}

func benchChain(b *testing.B, in []byte) {
	fx := chain(b)
	dst := fx(nil, in)
	b.ReportAllocs()
	for b.Loop() {
		dst = fx(dst[:0], in)
	}
	sinkLen += len(dst)
}

func BenchmarkVoiceEffectChainFrame(b *testing.B) { benchChain(b, pcm24kFrame) }

func BenchmarkVoiceEffectChain1s(b *testing.B) { benchChain(b, pcm24k1s) }
