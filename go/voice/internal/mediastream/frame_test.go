package mediastream

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/langwatch/scenario/go/voice/audio"
)

// Ported from twilio.test.ts ("Twilio Media Streams JSON protocol parses
// start, media, and stop events") plus parser edge cases.

func TestParseStartMediaStop(t *testing.T) {
	var p Parser
	f, ok := p.Parse([]byte(`{"event":"start","start":{"streamSid":"MZxxx","callSid":"CAxxx"}}`))
	if !ok || f.Event != EventStart || string(f.StreamSID) != "MZxxx" || f.CallSID != "CAxxx" {
		t.Fatalf("start = %+v, %v", f, ok)
	}
	payload := []byte{0xff, 0x7f, 0x00, 0x80}
	f, ok = p.Parse(AppendMediaFrame(nil, "MZxxx", payload))
	if !ok || f.Event != EventMedia || !bytes.Equal(f.Payload, payload) || string(f.StreamSID) != "MZxxx" {
		t.Fatalf("media = %+v, %v", f, ok)
	}
	f, ok = p.Parse([]byte(`{"event":"stop","streamSid":"MZxxx"}`))
	if !ok || f.Event != EventStop || f.Payload != nil {
		t.Fatalf("stop = %+v, %v", f, ok)
	}
}

func TestParseRealTwilioMediaFrame(t *testing.T) {
	var p Parser
	frame := `{ "event": "media", "sequenceNumber": "3", "media": { "track": "inbound", "chunk": "1",
		"timestamp": 5, "payload": "` + base64.StdEncoding.EncodeToString([]byte("abc")) + `" }, "streamSid": "MZ1", "x": [1, {"y": null}, true, -2.5e3] }`
	f, ok := p.Parse([]byte(frame))
	if !ok || string(f.Payload) != "abc" || string(f.StreamSID) != "MZ1" {
		t.Fatalf("got %+v, %v", f, ok)
	}
}

func TestParseFieldOrderAndEscapes(t *testing.T) {
	var p Parser
	// event after media; an escaped slash inside the base64 payload.
	f, ok := p.Parse([]byte(`{"media":{"payload":"\/w=="},"event":"media"}`))
	if !ok || !bytes.Equal(f.Payload, []byte{0xff}) {
		t.Fatalf("got %+v, %v", f, ok)
	}
	// unpadded payload is accepted, like Buffer.from(b64, "base64").
	f, ok = p.Parse([]byte(`{"event":"media","media":{"payload":"/w"}}`))
	if !ok || !bytes.Equal(f.Payload, []byte{0xff}) {
		t.Fatalf("unpadded: got %+v, %v", f, ok)
	}
	f, ok = p.Parse([]byte(`{"event":"stop","streamSid":"MZ\"1"}`))
	if !ok || f.Event != EventStop || string(f.StreamSID) != `MZ"1` {
		t.Fatalf("escaped: got %+v, %v", f, ok)
	}
}

func TestParseRejects(t *testing.T) {
	var p Parser
	for _, in := range []string{
		``, `not json`, `{"event":"media"`, `{"event":42}`, `{"streamSid":"x"}`,
		`{"event":"bogus"}`, `{"event":"media"}`, `{"event":"media","media":{"payload":7}}`,
		`{"event":"media","media":{"payload":"!!!"}}`, `{"event":"dtmf","dtmf":{}}`,
		`{"event":"dtmf","dtmf":{"digit":5}}`, `{"event":"stop"} trailing`, `{"event":"stop","n":01}`,
		`{"event":"stop","n":tru}`,
	} {
		if f, ok := p.Parse([]byte(in)); ok {
			t.Errorf("Parse(%q) = %+v, want rejected", in, f)
		}
	}
}

func TestParseControlFrames(t *testing.T) {
	var p Parser
	f, ok := p.Parse([]byte(`{"event":"dtmf","streamSid":"MZ","dtmf":{"digit":"5"}}`))
	if !ok || f.DTMFDigit != "5" {
		t.Fatalf("dtmf = %+v", f)
	}
	f, ok = p.Parse([]byte(`{"event":"mark","mark":{"name":"utterance_end"}}`))
	if !ok || f.MarkName != "utterance_end" {
		t.Fatalf("mark = %+v", f)
	}
	f, ok = p.Parse([]byte(`{"event":"mark"}`))
	if !ok || f.MarkName != "" {
		t.Fatalf("bare mark = %+v", f)
	}
	f, ok = p.Parse([]byte(`{"event":"start","start":{"streamSid":"MZ","customParameters":{"nonce":"abc","n":3}}}`))
	if !ok || string(f.StreamSID) != "MZ" || len(f.CustomParameters) != 1 || f.CustomParameters["nonce"] != "abc" {
		t.Fatalf("start = %+v", f)
	}
	f, ok = p.Parse([]byte(`{"event":"start","streamSid":"TOP","start":"weird"}`))
	if !ok || string(f.StreamSID) != "TOP" || f.CustomParameters == nil {
		t.Fatalf("odd start = %+v", f)
	}
	if f, ok = p.Parse([]byte(`{"event":"connected","protocol":"Call"}`)); !ok || f.Event != EventConnected {
		t.Fatalf("connected = %+v", f)
	}
}

func TestEncodeFramesMatchJSONStringify(t *testing.T) {
	got := string(AppendMediaFrame(nil, "MZ\"1", []byte{1, 2, 3}))
	want := `{"event":"media","streamSid":"MZ\"1","media":{"payload":"AQID"}}`
	if got != want {
		t.Fatalf("media = %s, want %s", got, want)
	}
	if got := string(AppendClearFrame(nil, "MZ")); got != `{"event":"clear","streamSid":"MZ"}` {
		t.Fatalf("clear = %s", got)
	}
	if got := string(AppendMarkFrame(nil, "MZ", "utterance_end")); got != `{"event":"mark","streamSid":"MZ","mark":{"name":"utterance_end"}}` {
		t.Fatalf("mark = %s", got)
	}
	if got := string(AppendStopFrame(nil, "MZ")); got != `{"event":"stop","streamSid":"MZ"}` {
		t.Fatalf("stop = %s", got)
	}
	// Every escaped form decodes back to the input.
	for _, s := range []string{"a\x01b\n\t\\\"<&>é", "\xff"} {
		var back string
		if err := json.Unmarshal(appendJSONString(nil, s), &back); err != nil {
			t.Fatalf("%q: %v", s, err)
		}
		if want := strings.ToValidUTF8(s, "�"); back != want {
			t.Fatalf("round trip %q -> %q", s, back)
		}
	}
}

type recorder struct {
	frames [][]byte
	at     []time.Time
}

func (r *recorder) WriteText(_ context.Context, p []byte) error {
	r.frames = append(r.frames, bytes.Clone(p))
	r.at = append(r.at, time.Now())
	return nil
}

func TestSenderFramesAndPaces(t *testing.T) {
	s := Sender{Interval: 10 * time.Millisecond}
	var r recorder
	pcm := make([]byte, 2*3*170) // 170 µ-law samples: one full frame and a 10-byte tail
	start := time.Now()
	if err := s.Send(context.Background(), &r, "MZ", pcm); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed < 20*time.Millisecond {
		t.Fatalf("two frames returned after %v, want >= 2 intervals", elapsed)
	}
	var p Parser
	var sizes []int
	for _, fr := range r.frames {
		f, ok := p.Parse(fr)
		if !ok {
			t.Fatalf("unparseable %s", fr)
		}
		sizes = append(sizes, len(f.Payload))
	}
	if len(sizes) != 2 || sizes[0] != FrameBytes || sizes[1] != 10 {
		t.Fatalf("frame sizes %v, want [160 10]", sizes)
	}
	if gap := r.at[1].Sub(r.at[0]); gap < 8*time.Millisecond {
		t.Fatalf("frames %v apart, want paced", gap)
	}
	// A second send reuses the ticker.
	if err := s.Send(context.Background(), &r, "MZ", pcm[:960]); err != nil || len(r.frames) != 3 {
		t.Fatalf("second send: %v, %d frames", err, len(r.frames))
	}
	if err := s.Send(context.Background(), &r, "MZ", nil); err != nil || len(r.frames) != 3 {
		t.Fatalf("empty send wrote frames")
	}
}

func TestSenderStopsOnCancel(t *testing.T) {
	s := Sender{Interval: time.Hour}
	ctx, cancel := context.WithCancel(context.Background())
	var r recorder
	go func() { time.Sleep(10 * time.Millisecond); cancel() }()
	if err := s.Send(ctx, &r, "MZ", make([]byte, 9600)); err != context.Canceled || len(r.frames) != 1 {
		t.Fatalf("err %v after %d frames", err, len(r.frames))
	}
}

func TestQueue(t *testing.T) {
	var q Queue
	ctx := context.Background()
	if _, err := q.Take(ctx, 5*time.Millisecond); err != ErrTakeTimeout {
		t.Fatalf("empty take: %v", err)
	}
	q.Put(audio.Chunk{Data: []byte{1, 2}})
	q.Put(audio.Chunk{})
	if q.Len() != 2 || !q.HasAudio() {
		t.Fatal("buffered state")
	}
	if c, _ := q.Take(ctx, time.Second); len(c.Data) != 2 {
		t.Fatal("FIFO head")
	}
	if q.HasAudio() {
		t.Fatal("only the sentinel is left")
	}
	q.Clear()
	done := make(chan audio.Chunk)
	go func() { c, _ := q.Take(ctx, time.Second); done <- c }()
	waitParked(t, &q)
	q.Clear() // parked consumer keeps waiting
	q.Put(audio.Chunk{Data: []byte{9, 9}})
	if c := <-done; len(c.Data) != 2 {
		t.Fatal("parked consumer not handed the chunk")
	}
	errc := make(chan error)
	go func() { _, err := q.Take(ctx, time.Second); errc <- err }()
	waitParked(t, &q)
	q.Fail(context.Canceled)
	if err := <-errc; err != context.Canceled {
		t.Fatalf("fail: %v", err)
	}
	go func() { _, err := q.Take(ctx, time.Second); errc <- err }()
	waitParked(t, &q)
	q.FailWaiters(context.DeadlineExceeded)
	if err := <-errc; err != context.DeadlineExceeded {
		t.Fatalf("FailWaiters: %v", err)
	}
	q.Put(audio.Chunk{Data: []byte{1, 1}})
	q.FailWaiters(context.Canceled) // nobody parked: the chunk stays
	if q.Len() != 1 {
		t.Fatal("FailWaiters dropped a buffered chunk")
	}
	q.Clear()
	go func() { c, _ := q.Take(ctx, time.Second); done <- c }()
	waitParked(t, &q)
	q.Wake(audio.Chunk{})
	if c := <-done; len(c.Data) != 0 || q.Len() != 0 {
		t.Fatal("wake")
	}
}

func TestQueueCompacts(t *testing.T) {
	var q Queue
	for i := range 1000 {
		q.Put(audio.Chunk{Data: []byte{byte(i), 0}})
		if c, _ := q.Take(context.Background(), time.Second); c.Data[0] != byte(i) {
			t.Fatal("order")
		}
	}
	if cap(q.items) > 4 {
		t.Fatalf("backing array grew to %d", cap(q.items))
	}
}

func waitParked(t *testing.T, q *Queue) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		q.mu.Lock()
		n := len(q.waiters)
		q.mu.Unlock()
		if n > 0 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("consumer never parked")
}
