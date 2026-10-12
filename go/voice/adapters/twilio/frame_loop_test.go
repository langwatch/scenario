package twilio

// Ported from twilio-frame-loop.test.ts (AC14): the ungated a-leg
// bidirectional frame-loop tripwire. Nothing below the socket is mocked; the
// expected samples come from an independent µ-law decoder and are compared
// positionally against a ramp visiting all 256 code points.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/internal/mediastream"
)

const (
	framesPerBatch = 5
	batchMulaw     = framesPerBatch * mediastream.FrameBytes
	upsample       = 3
)

// refMulawDecode is a G.711 µ-law decoder independent of the adapter's.
func refMulawDecode(b byte) int16 {
	inv := ^b
	mag := ((int32(inv&0x0f)<<3 | 0x84) << ((inv >> 4) & 0x07)) - 0x84
	if inv&0x80 != 0 {
		return int16(-mag)
	}
	return int16(mag)
}

func TestALegFrameLoopCarriesAudioBothWays(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest))
	nonce, call := startALegCall(t, a, rest)

	ramp := make([]byte, batchMulaw)
	ref := make([]int16, batchMulaw)
	for i := range ramp {
		ramp[i] = byte(i % 256)
		ref[i] = refMulawDecode(ramp[i])
	}
	frames := []string{startFrame(startOpts{nonce: nonce})}
	for i := 0; i < batchMulaw; i += mediastream.FrameBytes {
		frames = append(frames, mediaFrame("MZ762", ramp[i:i+mediastream.FrameBytes]))
	}
	ws := newConn(frames...)
	drive(t, a, ws, false)
	if err := await(t, call); err != nil {
		t.Fatal(err)
	}

	// Inbound: input sample i lands exactly on output index 3i.
	chunk, err := a.ReceiveAudio(context.Background(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	got := make([]int16, len(ref)-1)
	for i := range got {
		got[i] = audio.Sample(chunk.Data, upsample*i)
	}
	if !reflect.DeepEqual(got, ref[:len(ref)-1]) {
		t.Fatal("inbound µ-law reached the queue mis-decoded, reordered or resampled wrong")
	}
	if d := len(chunk.Data)/2 - upsample*batchMulaw; d < -2 || d > 2 {
		t.Fatalf("decoded %d samples", len(chunk.Data)/2)
	}
	if n := state(a, func(a *Adapter) int { return a.framesReceived }); n != framesPerBatch {
		t.Fatalf("frames received %d", n)
	}

	// Outbound: hold each level three samples so the downsample inverts the
	// upsample; every level is a µ-law code, so the encode round-trips.
	pcm := make([]byte, 2*len(ref)*upsample)
	for i := range len(ref) * upsample {
		audio.PutSample(pcm, i, ref[i/upsample])
	}
	if err := a.SendAudio(context.Background(), voice.AudioChunk{Data: pcm}); err != nil {
		t.Fatal(err)
	}
	var emitted []int16
	sent := ws.sentFrames()
	if len(sent) != framesPerBatch {
		t.Fatalf("%d frames sent", len(sent))
	}
	for _, raw := range sent {
		var f struct {
			Event, StreamSid string
			Media            struct{ Payload string }
		}
		if err := json.Unmarshal(raw, &f); err != nil || f.Event != "media" || f.StreamSid != "MZ762" {
			t.Fatalf("frame %s", raw)
		}
		p, _ := base64.StdEncoding.DecodeString(f.Media.Payload)
		if len(p) != mediastream.FrameBytes {
			t.Fatalf("payload %d bytes", len(p))
		}
		for _, b := range p {
			emitted = append(emitted, refMulawDecode(b))
		}
	}
	if !reflect.DeepEqual(emitted, ref) {
		t.Fatal("outbound PCM16 left the socket mis-encoded, reordered or resampled wrong")
	}
}

func TestSendAudioPacesAtRealTime(t *testing.T) {
	rest := newSpyREST()
	a := connected(t, makeAdapter(t, rest, withoutGate()))
	ws := newConn(startFrame(startOpts{}))
	drive(t, a, ws, false)
	start := time.Now()
	// 100 ms of audio: five 20 ms frames.
	if err := a.SendAudio(context.Background(), voice.AudioChunk{Data: make([]byte, 4800)}); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed < 90*time.Millisecond {
		t.Fatalf("100 ms of audio sent in %v", elapsed)
	}
}
