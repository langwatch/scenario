package openairealtime

import (
	"encoding/base64"
	"testing"

	"github.com/langwatch/scenario/go/voice"
)

// The per-frame paths: encoding user audio into input_audio_buffer.append
// frames and decoding agent audio out of response.output_audio.delta
// frames.

func BenchmarkAppendAudioFrame(b *testing.B) {
	pcm := voice.SilentChunk(0.1).Data // 100 ms at 24 kHz
	var buf []byte
	b.SetBytes(int64(len(pcm)))
	b.ReportAllocs()
	for b.Loop() {
		buf = appendAudioFrame(buf[:0], pcm)
	}
}

func BenchmarkDecodeAudioDelta(b *testing.B) {
	pcm := voice.SilentChunk(0.1).Data
	frame := []byte(`{"type":"response.output_audio.delta","event_id":"event_abc","response_id":"resp_1","item_id":"item_1",` +
		`"output_index":0,"content_index":0,"delta":"` + base64.StdEncoding.EncodeToString(pcm) + `"}`)
	b.SetBytes(int64(len(pcm)))
	b.ReportAllocs()
	for b.Loop() {
		ev, ok := decodeEvent(frame)
		if !ok || len(ev.audio) != len(pcm) {
			b.Fatal("decode failed")
		}
	}
}

func TestDecodeAudioDeltaAllocatesOnlyThePCM(t *testing.T) {
	frame := []byte(`{"type":"response.output_audio.delta","event_id":"e","delta":"` + base64.StdEncoding.EncodeToString(make([]byte, 4800)) + `"}`)
	if n := testing.AllocsPerRun(100, func() { _, _ = decodeEvent(frame) }); n != 1 {
		t.Fatalf("allocs = %v, want 1 (the PCM)", n)
	}
	var buf []byte
	pcm := make([]byte, 4800)
	buf = appendAudioFrame(buf, pcm)
	if n := testing.AllocsPerRun(100, func() { buf = appendAudioFrame(buf[:0], pcm) }); n != 0 {
		t.Fatalf("encode allocs = %v", n)
	}
}

func TestDecodeEventPaths(t *testing.T) {
	// Field order and the Beta name do not matter on the fast path.
	ev, ok := decodeEvent([]byte(`{"delta":"AQACAA==","type":"response.audio.delta"}`))
	if !ok || ev.Type != evAudioDeltaBeta || string(ev.audio) != "\x01\x00\x02\x00" {
		t.Fatalf("ev = %+v", ev)
	}
	// An escaped solidus inside the base64 takes the slow path.
	ev, ok = decodeEvent([]byte(`{"type":"response.output_audio.delta","delta":"\/w=="}`))
	if !ok || string(ev.audio) != "\xff" {
		t.Fatalf("escaped ev = %+v", ev)
	}
	ev, ok = decodeEvent([]byte(`{"type":"response.done","response":{"usage":{"input_tokens":3}}}`))
	if u, has := ev.usage(); !ok || !has || u["input_tokens"] != 3.0 {
		t.Fatalf("usage = %v", u)
	}
	if _, ok := decodeEvent([]byte(`[1,2]`)); ok {
		t.Fatal("accepted an array")
	}
}
