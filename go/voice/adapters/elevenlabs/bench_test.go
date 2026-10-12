package elevenlabs

import (
	"encoding/base64"
	"encoding/json"
	"testing"

	"github.com/coder/websocket"
	"github.com/langwatch/scenario/go/voice/internal/wsconn"
)

// Per-frame paths: the 20 ms microphone frame out, agent audio and pings in.

func BenchmarkEncodeUserAudioChunk(b *testing.B) {
	pcm := make([]byte, pumpFrameBytes)
	dst := make([]byte, 0, userAudioChunkLen(pumpFrameBytes))
	b.ReportAllocs()
	b.SetBytes(pumpFrameBytes)
	for b.Loop() {
		dst = appendUserAudioChunk(dst[:0], pcm)
	}
}

func BenchmarkNextPumpFrame(b *testing.B) {
	tr := must(New(Options{AgentID: "a", APIKey: "k"}))
	tr.conn, tr.open = wsconn.FromCoder(&websocket.Conn{}), true // never written: only the frame is built
	speech := make([]byte, 50*pumpFrameBytes)
	dst := make([]byte, 0, userAudioChunkLen(pumpFrameBytes))
	b.ReportAllocs()
	b.SetBytes(pumpFrameBytes)
	for b.Loop() {
		tr.mu.Lock()
		if tr.outPos == len(tr.out) {
			tr.enqueueLocked(speech)
		}
		tr.mu.Unlock()
		dst, _ = tr.nextPumpFrame(dst[:0])
	}
}

// agentAudioFrame is a typical ElevenLabs audio event: 250 ms of PCM.
func agentAudioFrame() []byte {
	data, _ := json.Marshal(map[string]any{"type": "audio", "audio_event": map[string]any{
		"audio_base_64": base64.StdEncoding.EncodeToString(make([]byte, 12000)), "event_id": 17}})
	return data
}

func BenchmarkParseAudioFrame(b *testing.B) {
	data := agentAudioFrame()
	var f inboundFrame
	b.ReportAllocs()
	b.SetBytes(int64(len(data)))
	for b.Loop() {
		if !parseFrame(data, &f) {
			b.Fatal("not parsed")
		}
		if _, err := decodeAudio(f.audioB64); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkHandleAudioMessage(b *testing.B) {
	tr := must(New(Options{AgentID: "a", APIKey: "k"}))
	rs := readState{buf: agentAudioFrame()}
	b.ReportAllocs()
	for b.Loop() {
		tr.handleMessage(b.Context(), nil, &rs)
		tr.mu.Lock()
		tr.queue = tr.queue[:0]
		tr.mu.Unlock()
	}
}

func BenchmarkParsePingAndPong(b *testing.B) {
	data := []byte(`{"type":"ping","ping_event":{"event_id":123,"ping_ms":45}}`)
	var f inboundFrame
	pong := make([]byte, 0, 64)
	b.ReportAllocs()
	for b.Loop() {
		if !parseFrame(data, &f) {
			b.Fatal("not parsed")
		}
		pong = appendPong(pong[:0], f.eventID)
	}
}
