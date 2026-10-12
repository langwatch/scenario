package geminilive

import (
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"testing"

	"github.com/langwatch/scenario/go/voice"
)

// The resampler matches the JavaScript adapter's sample for sample
// (reference values computed with its resamplePcm16).
func TestResampleMatchesJavaScript(t *testing.T) {
	const n = 301
	in := make([]byte, 2*n)
	for i := range n {
		binary.LittleEndian.PutUint16(in[2*i:], uint16(int16((i*7919)%65536-32768)))
	}
	out := appendResampled(nil, in, 24000, 16000)
	var h uint32
	for _, b := range out {
		h = h*31 + uint32(b)
	}
	if len(out) != 400 || h != 1743344466 || fmt.Sprint(out[:12]) != "[0 128 162 174 68 221 231 11 137 58 43 105]" {
		t.Fatalf("len %d hash %d head %v", len(out), h, out[:12])
	}
	if got := appendResampled(nil, []byte{5, 1, 0, 0, 0, 0}, 24000, 16000); fmt.Sprint(got) != "[5 1 0 0]" {
		t.Fatalf("3 samples = %v", got)
	}
	if got := appendResampled(nil, []byte{1, 0}, 24000, 16000); len(got) != 0 {
		t.Fatalf("1 sample = %v", got)
	}
	if got := appendResampled(nil, []byte{1, 0, 2, 0, 3}, 16000, 16000); fmt.Sprint(got) != "[1 0 2 0]" {
		t.Fatalf("same rate = %v", got)
	}
}

func TestDecodeServerMessage(t *testing.T) {
	m, ok := decodeServerMessage([]byte(`{"serverContent":{"modelTurn":{"parts":[{"text":"x"},{"inlineData":{"data":"AQID"}},` +
		`{"inlineData":{"mimeType":"audio/pcm","data":"BAU="}}]},"outputTranscription":{"text":"hé"},"interrupted":true}}`))
	if !ok || !m.hasContent || !m.interrupted || m.turnComplete || m.transcript != "hé" {
		t.Fatalf("m = %+v", m)
	}
	if fmt.Sprint(m.audio) != "[1 2 3 4]" { // 5 bytes trimmed to whole samples
		t.Fatalf("audio = %v", m.audio)
	}
	if m, ok := decodeServerMessage([]byte(`{"goAway":{"timeLeft":"1s"}}`)); !ok || m.goAway != `{"timeLeft":"1s"}` || m.hasContent {
		t.Fatalf("goAway = %+v", m)
	}
	if m, ok := decodeServerMessage([]byte(`{"setupComplete":{}}`)); !ok || m.hasContent {
		t.Fatalf("setup = %+v", m)
	}
	if _, ok := decodeServerMessage([]byte(`nope`)); ok {
		t.Fatal("accepted a non-JSON frame")
	}
}

func audioFrame(pcm []byte) []byte {
	return []byte(`{"serverContent":{"modelTurn":{"role":"model","parts":[{"inlineData":{"mimeType":"audio/pcm;rate=24000","data":"` +
		base64.StdEncoding.EncodeToString(pcm) + `"}}]}}}`)
}

func TestPerFrameAllocations(t *testing.T) {
	if raceEnabled {
		t.Skip("the race detector changes allocation counts")
	}
	frame := audioFrame(make([]byte, 4800))
	if n := testing.AllocsPerRun(100, func() { _, _ = decodeServerMessage(frame) }); n != 1 {
		t.Fatalf("decode allocs = %v, want 1 (the PCM)", n)
	}
	pcm := voice.SilentChunk(0.1).Data
	var res, buf []byte
	res = appendResampled(res, pcm, 24000, 16000)
	buf = appendAudioFrame(buf, res)
	if n := testing.AllocsPerRun(100, func() {
		res = appendResampled(res[:0], pcm, 24000, 16000)
		buf = appendAudioFrame(buf[:0], res)
	}); n != 0 {
		t.Fatalf("encode allocs = %v", n)
	}
}

// BenchmarkEncodeUserFrame is the per-turn send path: 24 kHz → 16 kHz and
// the base64 realtimeInput frame, into reused buffers.
func BenchmarkEncodeUserFrame(b *testing.B) {
	pcm := voice.SilentChunk(0.1).Data
	var res, buf []byte
	b.SetBytes(int64(len(pcm)))
	b.ReportAllocs()
	for b.Loop() {
		res = appendResampled(res[:0], pcm, 24000, 16000)
		buf = appendAudioFrame(buf[:0], res)
	}
}

// BenchmarkDecodeAudioFrame is the per-frame receive path.
func BenchmarkDecodeAudioFrame(b *testing.B) {
	pcm := voice.SilentChunk(0.1).Data
	frame := audioFrame(pcm)
	b.SetBytes(int64(len(pcm)))
	b.ReportAllocs()
	for b.Loop() {
		if m, ok := decodeServerMessage(frame); !ok || len(m.audio) != len(pcm) {
			b.Fatal("decode failed")
		}
	}
}
