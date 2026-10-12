package pipecat

// Ported from pipecat.test.ts and pipecat-spans.test.ts, against an
// httptest WebSocket server standing in for the Pipecat bot.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/audio"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

var spans = tracetest.NewInMemoryExporter()

func TestMain(m *testing.M) {
	otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sdktrace.NewSimpleSpanProcessor(spans))))
	os.Exit(m.Run())
}

// bot is a fake Pipecat bot: it records every frame the adapter sends and
// pushes frames back on demand.
type bot struct {
	t      *testing.T
	mu     sync.Mutex
	frames []string
	conn   *websocket.Conn
	ready  chan struct{}
	url    string
}

func newBot(t *testing.T) *bot {
	t.Helper()
	b := &bot{t: t, ready: make(chan struct{})}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		b.mu.Lock()
		b.conn = c
		b.mu.Unlock()
		close(b.ready)
		for {
			_, data, err := c.Read(context.Background())
			if err != nil {
				return
			}
			b.mu.Lock()
			b.frames = append(b.frames, string(data))
			b.mu.Unlock()
		}
	}))
	t.Cleanup(srv.Close)
	b.url = "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	return b
}

func (b *bot) send(typ websocket.MessageType, p []byte) {
	<-b.ready
	if err := b.conn.Write(context.Background(), typ, p); err != nil {
		b.t.Errorf("bot send: %v", err)
	}
}

func (b *bot) push(frame string) { b.send(websocket.MessageText, []byte(frame)) }

func (b *bot) closeSocket() {
	<-b.ready
	_ = b.conn.Close(websocket.StatusNormalClosure, "")
}

func (b *bot) byEvent(event string) []map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []map[string]any
	for _, f := range b.frames {
		var m map[string]any
		if json.Unmarshal([]byte(f), &m) == nil && m["event"] == event {
			out = append(out, m)
		}
	}
	return out
}

func (b *bot) waitEvent(event string, n int) []map[string]any {
	b.t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if got := b.byEvent(event); len(got) >= n {
			return got
		}
		time.Sleep(2 * time.Millisecond)
	}
	b.t.Fatalf("bot never received %d %q frames", n, event)
	return nil
}

func newAdapter(t *testing.T, b *bot, mod ...func(*Options)) *Adapter {
	t.Helper()
	o := Options{URL: b.url, StreamSID: "MZtest", CallSID: "CAtest", DisablePacing: true}
	for _, f := range mod {
		f(&o)
	}
	a, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func connect(t *testing.T, a *Adapter) {
	t.Helper()
	if err := a.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Disconnect(context.Background()) })
}

// mulawMedia is a media frame carrying samples of constant amplitude,
// encoded at 8 kHz.
func mulawMedia(streamSID string, samples int, amp int16) string {
	pcm := make([]byte, 2*samples)
	for i := range samples {
		audio.PutSample(pcm, i, amp)
	}
	b, _ := json.Marshal(map[string]any{"event": "media", "streamSid": streamSID,
		"media": map[string]string{"payload": base64.StdEncoding.EncodeToString(audio.AppendMulaw(nil, pcm))}})
	return string(b)
}

func TestExchangesAudioWithABotOverWebSocket(t *testing.T) {
	b := newBot(t)
	a := newAdapter(t, b)
	connect(t, a)
	pcm := make([]byte, 960) // 20 ms: one Twilio frame
	for i := range 480 {
		audio.PutSample(pcm, i, 5000)
	}
	if err := a.SendAudio(context.Background(), voice.AudioChunk{Data: pcm}); err != nil {
		t.Fatal(err)
	}
	b.push(mulawMedia("MZtest", 800, 8000))
	got, err := a.ReceiveAudio(context.Background(), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}

	if len(b.waitEvent("connected", 1)) != 1 {
		t.Fatal("connected frames")
	}
	starts := b.waitEvent("start", 1)
	start := starts[0]["start"].(map[string]any)
	mf := start["mediaFormat"].(map[string]any)
	if len(starts) != 1 || start["streamSid"] != "MZtest" || start["callSid"] != "CAtest" ||
		mf["encoding"] != "audio/x-mulaw" || mf["sampleRate"] != 8000.0 {
		t.Fatalf("start %v", starts)
	}
	for _, f := range b.waitEvent("media", 1) {
		p, _ := base64.StdEncoding.DecodeString(f["media"].(map[string]any)["payload"].(string))
		if len(p) == 0 || len(p) > 160 {
			t.Fatalf("frame of %d bytes", len(p))
		}
	}
	if marks := b.waitEvent("mark", 1); marks[0]["mark"].(map[string]any)["name"] != "utterance_end" {
		t.Fatalf("mark %v", marks)
	}
	if n := len(got.Data); n < 4796 || n > 4804 {
		t.Fatalf("received %d bytes, want ~4800", n)
	}
	if a.TransportFormat() != "mulaw/8000" {
		t.Fatalf("format %q", a.TransportFormat())
	}
	c := a.Capabilities()
	if !strings.Contains(strings.Join(c.InputFormats, ","), "mulaw/8000") || !strings.Contains(strings.Join(c.OutputFormats, ","), "mulaw/8000") ||
		!c.NativeVAD || !c.Interruption || c.DTMF {
		t.Fatalf("caps %+v", c)
	}
}

func TestWebRTCIsAPendingTransport(t *testing.T) {
	a, err := New(Options{Transport: TransportWebRTC, SignalingURL: "https://example.test/webrtc"})
	if err != nil {
		t.Fatal(err)
	}
	var pte *voice.PendingTransportError
	if err := a.Connect(context.Background()); !errors.As(err, &pte) || !strings.Contains(err.Error(), "webrtc") {
		t.Fatalf("err %v", err)
	}
	if _, err := New(Options{}); err == nil || !strings.Contains(err.Error(), "requires url=") {
		t.Fatalf("missing url: %v", err)
	}
	if _, err := New(Options{Transport: TransportWebRTC}); err == nil || !strings.Contains(err.Error(), "requires signalingUrl=") {
		t.Fatalf("missing signaling url: %v", err)
	}
}

func TestInterruptSendsClearAndTruncates(t *testing.T) {
	b := newBot(t)
	a := newAdapter(t, b, func(o *Options) { o.StreamSID = "MZclear" })
	connect(t, a)
	woken := make(chan int, 1)
	go func() {
		c, _ := a.ReceiveAudio(context.Background(), 2*time.Second)
		woken <- len(c.Data)
	}()
	waitParked(t, a)
	if err := a.Interrupt(context.Background()); err != nil {
		t.Fatal(err)
	}
	clears := b.waitEvent("clear", 1)
	if len(clears) != 1 || clears[0]["streamSid"] != "MZclear" {
		t.Fatalf("clear %v", clears)
	}
	if n := <-woken; n != 0 {
		t.Fatalf("waiting receive got %d bytes", n)
	}
	// The next receive ends the turn; late frames are dropped until the
	// next user turn.
	b.push(mulawMedia("MZclear", 800, 8000))
	time.Sleep(50 * time.Millisecond)
	if c, err := a.ReceiveAudio(context.Background(), time.Second); err != nil || len(c.Data) != 0 {
		t.Fatalf("after interrupt: %d bytes, %v", len(c.Data), err)
	}
	if a.queue.Len() != 0 {
		t.Fatal("late frames of the interrupted turn were queued")
	}
	if err := a.SendAudio(context.Background(), voice.AudioChunk{Data: make([]byte, 960)}); err != nil {
		t.Fatal(err)
	}
	b.push(mulawMedia("MZclear", 800, 8000))
	if c, err := a.ReceiveAudio(context.Background(), time.Second); err != nil || len(c.Data) == 0 {
		t.Fatalf("recovery turn: %d bytes, %v", len(c.Data), err)
	}
}

func waitParked(t *testing.T, a *Adapter) {
	t.Helper()
	time.Sleep(20 * time.Millisecond)
}

func TestStopFlushesAPartialBatch(t *testing.T) {
	b := newBot(t)
	a := newAdapter(t, b)
	connect(t, a)
	b.push(mulawMedia("MZedge", 160, 8000))
	b.push(`{"event":"stop","streamSid":"MZedge"}`)
	c, err := a.ReceiveAudio(context.Background(), time.Second)
	if err != nil || len(c.Data) < 956 || len(c.Data) > 964 {
		t.Fatalf("%d bytes, %v", len(c.Data), err)
	}
}

func TestCloseFlushesAPartialBatchThenFails(t *testing.T) {
	b := newBot(t)
	a := newAdapter(t, b)
	connect(t, a)
	b.push(mulawMedia("MZedge", 160, 8000))
	time.Sleep(20 * time.Millisecond)
	b.closeSocket()
	c, err := a.ReceiveAudio(context.Background(), time.Second)
	if err != nil || len(c.Data) == 0 {
		t.Fatalf("%d bytes, %v", len(c.Data), err)
	}
	if _, err := a.ReceiveAudio(context.Background(), time.Second); err == nil || !strings.Contains(err.Error(), "socket closed") {
		t.Fatalf("after close: %v", err)
	}
}

func TestBinaryFramesAreRawMulaw(t *testing.T) {
	b := newBot(t)
	a := newAdapter(t, b)
	connect(t, a)
	raw := make([]byte, 800)
	for i := range raw {
		raw[i] = 0x10
	}
	b.send(websocket.MessageBinary, raw)
	if c, err := a.ReceiveAudio(context.Background(), time.Second); err != nil || len(c.Data) < 4796 {
		t.Fatalf("%d bytes, %v", len(c.Data), err)
	}
}

func TestDisconnectSendsStopAndCloses(t *testing.T) {
	b := newBot(t)
	a := newAdapter(t, b)
	if err := a.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !a.IsConnected() {
		t.Fatal("not connected")
	}
	if err := a.Disconnect(context.Background()); err != nil {
		t.Fatal(err)
	}
	if stops := b.waitEvent("stop", 1); stops[0]["streamSid"] != "MZtest" {
		t.Fatalf("stop %v", stops)
	}
	if a.IsConnected() {
		t.Fatal("still connected")
	}
	if _, err := a.ReceiveAudio(context.Background(), time.Millisecond); err == nil || !strings.Contains(err.Error(), "not connected") {
		t.Fatalf("receive after disconnect: %v", err)
	}
	if err := a.Disconnect(context.Background()); err != nil {
		t.Fatal("second disconnect")
	}
}

func TestGeneratedSIDsAndPacing(t *testing.T) {
	b := newBot(t)
	a := newAdapter(t, b, func(o *Options) { o.StreamSID, o.CallSID, o.DisablePacing = "", "", false })
	connect(t, a)
	start := b.waitEvent("start", 1)[0]["start"].(map[string]any)
	if s := start["streamSid"].(string); !strings.HasPrefix(s, "MZ") || len(s) != 34 {
		t.Fatalf("stream SID %q", s)
	}
	began := time.Now()
	if err := a.SendAudio(context.Background(), voice.AudioChunk{Data: make([]byte, 4800)}); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(began); d < 90*time.Millisecond {
		t.Fatalf("100 ms sent in %v", d)
	}
}

// Spans (pipecat-spans.test.ts).

func spanByName(name string) (tracetest.SpanStub, bool) {
	ss := spans.GetSpans()
	for i := len(ss) - 1; i >= 0; i-- {
		if ss[i].Name == name {
			return ss[i], true
		}
	}
	return tracetest.SpanStub{}, false
}

func attrOf(s tracetest.SpanStub, key string) attribute.Value {
	for _, kv := range s.Attributes {
		if string(kv.Key) == key {
			return kv.Value
		}
	}
	return attribute.Value{}
}

func receives(background bool) tracetest.SpanStubs {
	var out tracetest.SpanStubs
	for _, s := range spans.GetSpans() {
		if s.Name == voice.SpanAudioReceive && (attrOf(s, "voice.pipecat.recv.source").AsString() == "background_loop") == background {
			out = append(out, s)
		}
	}
	return out
}

func agent(a *Adapter) *voice.Agent {
	ag := voice.NewAgent(a)
	ag.ResponseTailSilence = 50 * time.Millisecond
	ag.ResponseTimeout = 2 * time.Second
	ag.TranscriptGraceWait = 0
	return ag
}

func userAudio() scenario.AgentInput {
	return scenario.AgentInput{NewMessages: []scenario.Message{voice.AudioMessage(voice.AudioChunk{Data: make([]byte, 2400)}, scenario.RoleUser)}}
}

// turnWhile runs a turn, calling during once the turn is live.
func turnWhile(t *testing.T, a *Adapter, ag *voice.Agent, during func()) error {
	t.Helper()
	errc := make(chan error, 1)
	go func() { _, err := ag.Turn(context.Background(), userAudio()); errc <- err }()
	deadline := time.Now().Add(3 * time.Second)
	for {
		a.mu.Lock()
		live := a.turnCtx != nil
		a.mu.Unlock()
		if live || time.Now().After(deadline) {
			break
		}
		time.Sleep(time.Millisecond)
	}
	during()
	return <-errc
}

func TestSpanBaseSpansAndConnectAttributes(t *testing.T) {
	spans.Reset()
	b := newBot(t)
	a := newAdapter(t, b)
	ctx, span := voice.StartSpan(context.Background(), voice.SpanAdapterConnect)
	if err := a.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	voice.EndSpan(span, nil)
	t.Cleanup(func() { _ = a.Disconnect(context.Background()) })
	connectSpan, _ := spanByName(voice.SpanAdapterConnect)
	if attrOf(connectSpan, "voice.pipecat.transport").AsString() != "websocket" ||
		attrOf(connectSpan, "voice.pipecat.transport_format").AsString() != "mulaw/8000" {
		t.Fatalf("connect attrs %v", connectSpan.Attributes)
	}
	b.push(mulawMedia("MZtest", 800, 3000))
	time.Sleep(30 * time.Millisecond)
	if _, err := agent(a).Turn(context.Background(), userAudio()); err != nil {
		t.Fatal(err)
	}
	turn, ok := spanByName(voice.SpanTurn)
	if !ok || attrOf(turn, "voice.adapter.class").AsString() != "PipecatAgentAdapter" {
		t.Fatal("turn span")
	}
	for _, n := range []string{voice.SpanAudioSend, voice.SpanAudioReceive} {
		if s, ok := spanByName(n); !ok || s.Parent.SpanID() != turn.SpanContext.SpanID() {
			t.Fatalf("%s not under the turn", n)
		}
	}
	// Pre-buffered: a base receive span, no background marker.
	if len(receives(true)) != 0 || len(receives(false)) == 0 {
		t.Fatal("a pre-buffered turn got a background marker")
	}
}

func TestSpanBackgroundReceiveUnderTheTurnOncePerTurn(t *testing.T) {
	spans.Reset()
	b := newBot(t)
	a := newAdapter(t, b)
	connect(t, a)
	err := turnWhile(t, a, agent(a), func() {
		for range 3 {
			b.push(mulawMedia("MZtest", 800, 3000))
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	turn, _ := spanByName(voice.SpanTurn)
	bg := receives(true)
	if len(bg) != 1 || bg[0].Parent.SpanID() != turn.SpanContext.SpanID() || attrOf(bg[0], "voice.audio.bytes").AsInt64() <= 0 {
		t.Fatalf("%d background spans", len(bg))
	}
}

func TestSpanNoBackgroundSpanOutsideATurn(t *testing.T) {
	spans.Reset()
	b := newBot(t)
	a := newAdapter(t, b)
	connect(t, a)
	b.push(mulawMedia("MZtest", 800, 3000))
	time.Sleep(30 * time.Millisecond)
	_ = a.Disconnect(context.Background())
	if len(receives(true)) != 0 {
		t.Fatal("a frame outside a turn emitted a background span")
	}
}

func TestSpanReceiveTimeoutIsError(t *testing.T) {
	spans.Reset()
	b := newBot(t)
	a := newAdapter(t, b)
	connect(t, a)
	ag := agent(a)
	ag.ResponseTimeout = 50 * time.Millisecond
	_, err := ag.Turn(context.Background(), userAudio())
	if !errors.Is(err, voice.ErrReceiveTimeout) {
		t.Fatalf("err %v", err)
	}
	recv, _ := spanByName(voice.SpanAudioReceive)
	if recv.Status.Code != codes.Error || attrOf(recv, "voice.audio.terminated_reason").AsString() != "first_chunk_timeout" {
		t.Fatalf("receive span %v %v", recv.Status, recv.Attributes)
	}
}
