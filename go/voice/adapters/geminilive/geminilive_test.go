package geminilive

import (
	"context"
	"encoding/base64"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/internal/realtimetest"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

var spans = tracetest.NewInMemoryExporter()

func TestMain(m *testing.M) {
	os.Unsetenv("GEMINI_API_KEY")
	os.Unsetenv("GOOGLE_API_KEY")
	otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sdktrace.NewSimpleSpanProcessor(spans))))
	os.Exit(m.Run())
}

// connectAdapter connects an adapter to a fresh mock Live endpoint and
// waits for its setup message.
func connectAdapter(t *testing.T, o Options) (*realtimetest.Server, *Adapter) {
	t.Helper()
	srv := realtimetest.New(t)
	if o.APIKey == "" {
		o.APIKey = "test-key"
	}
	o.URL = srv.URL + "/ws"
	a := New(o)
	a.ResponseTailSilence = 50 * time.Millisecond
	a.ResponseTimeout = 2 * time.Second
	a.TranscriptGraceWait = 0
	srv.Arm()
	if err := a.Live().Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Live().Disconnect(context.Background()) })
	srv.WaitConnected(t)
	srv.WaitFor(t, func(fs []realtimetest.Frame) bool { return len(fs) > 0 })
	return srv, a
}

func audioB64() string { return base64.StdEncoding.EncodeToString([]byte{0, 0, 0, 0}) }

func audioMsg() map[string]any {
	return map[string]any{"serverContent": map[string]any{
		"modelTurn":           map[string]any{"parts": []any{map[string]any{"inlineData": map[string]any{"mimeType": "audio/pcm", "data": audioB64()}}}},
		"outputTranscription": map[string]any{"text": "hi"},
	}}
}

func turnComplete() map[string]any {
	return map[string]any{"serverContent": map[string]any{"turnComplete": true}}
}

func interrupted() map[string]any {
	return map[string]any{"serverContent": map[string]any{"interrupted": true}}
}

// push sends messages as the Live API does: binary frames.
func push(t *testing.T, srv *realtimetest.Server, msgs ...map[string]any) {
	t.Helper()
	for _, m := range msgs {
		srv.PushBinary(t, m)
	}
}

// tone is n bytes of non-silent PCM16.
func tone(n int) voice.AudioChunk {
	d := make([]byte, n)
	for i := range d {
		d[i] = byte(i%250 + 1)
	}
	return voice.AudioChunk{Data: d}
}

func audioInput(c *voice.AudioChunk) scenario.AgentInput {
	if c == nil {
		return scenario.AgentInput{}
	}
	return scenario.AgentInput{NewMessages: []scenario.Message{voice.AudioMessage(*c, scenario.RoleUser)}}
}

func receive(t *testing.T, a *Adapter, timeout time.Duration) voice.AudioChunk {
	t.Helper()
	c, err := a.Live().ReceiveAudio(context.Background(), timeout)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// awaitQueued waits until the read loop queued n messages.
func awaitQueued(t *testing.T, a *Adapter, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for a.Live().events.Len() < n {
		if time.Now().After(deadline) {
			t.Fatalf("queued %d of %d", a.Live().events.Len(), n)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func TestConnectsViaTheNativeAudioEndpoint(t *testing.T) {
	srv, a := connectAdapter(t, Options{Model: "gemini-2.5-flash-native-audio", Voice: "Algieba",
		SystemInstruction: "You are a helpful tour guide."})
	if a.Live().Model() != "gemini-2.5-flash-native-audio" || a.Live().Voice() != "Algieba" || a.Name() != className {
		t.Fatal("fields")
	}
	if got := srv.Headers()[0].Get("x-goog-api-key"); got != "test-key" {
		t.Fatalf("key header = %q", got)
	}
	setup, _ := srv.Frames()[0].Data["setup"].(map[string]any)
	want := map[string]any{
		"model": "models/gemini-2.5-flash-native-audio",
		"generationConfig": map[string]any{
			"responseModalities": []any{"AUDIO"},
			"speechConfig":       map[string]any{"voiceConfig": map[string]any{"prebuiltVoiceConfig": map[string]any{"voiceName": "Algieba"}}},
		},
		"systemInstruction":        map[string]any{"parts": []any{map[string]any{"text": "You are a helpful tour guide."}}},
		"realtimeInputConfig":      map[string]any{"automaticActivityDetection": map[string]any{"disabled": true}},
		"inputAudioTranscription":  map[string]any{},
		"outputAudioTranscription": map[string]any{},
	}
	if !reflect.DeepEqual(setup, want) {
		t.Fatalf("setup = %v", setup)
	}
	for _, s := range []string{a.Live().String(), a.Live().GoString()} {
		if strings.Contains(s, "test-key") || !strings.Contains(s, "api_key='***'") {
			t.Fatalf("string form = %s", s)
		}
	}
}

func TestAdvertisesTheNativeAudioCapabilities(t *testing.T) {
	c := New(Options{APIKey: "k"}).Capabilities()
	if !c.StreamingTranscripts || !c.NativeVAD || !c.Interruption || c.DTMF ||
		!slices.Contains(c.InputFormats, "pcm16/16000") || !slices.Contains(c.OutputFormats, "pcm16/24000") {
		t.Fatalf("capabilities = %+v", c)
	}
}

func TestDefaultsAndKeyFallback(t *testing.T) {
	t.Setenv("GOOGLE_API_KEY", "g-key")
	rt := NewTransport(Options{})
	if rt.model != DefaultModel || rt.voiceName != DefaultVoice || rt.apiKey != "g-key" || rt.url != DefaultURL {
		t.Fatalf("transport = %+v", rt)
	}
	t.Setenv("GEMINI_API_KEY", "gm-key")
	if rt := NewTransport(Options{}); rt.apiKey != "gm-key" {
		t.Fatalf("key = %s", rt.apiKey)
	}
}

// The spurious [interrupted, turnComplete] pair is absorbed: one receive
// returns the recovery audio.
func TestAbsorbsTheSpuriousPairInOneReceive(t *testing.T) {
	srv, a := connectAdapter(t, Options{})
	push(t, srv, interrupted(), turnComplete(), audioMsg(), turnComplete())
	awaitQueued(t, a, 4)
	if c := receive(t, a, 5*time.Second); len(c.Data) == 0 {
		t.Fatal("the spurious pair was not absorbed")
	}
}

func TestDoesNotSwallowARealTurnComplete(t *testing.T) {
	srv, a := connectAdapter(t, Options{})
	push(t, srv, audioMsg(), turnComplete())
	if c := receive(t, a, 5*time.Second); len(c.Data) == 0 {
		t.Fatal("real audio turn returned empty")
	}
	if c := receive(t, a, 5*time.Second); len(c.Data) != 0 {
		t.Fatal("turnComplete returned audio")
	}
}

func TestSpuriousPairThenBareTurnCompleteEndsTheTurn(t *testing.T) {
	srv, a := connectAdapter(t, Options{})
	push(t, srv, interrupted(), turnComplete(), turnComplete())
	if c := receive(t, a, 5*time.Second); len(c.Data) != 0 {
		t.Fatal("expected the empty end-of-turn sentinel")
	}
}

// Interrupt wakes an in-flight receive with the cut-off sentinel instead of
// letting it time out.
func TestInterruptWakesTheInFlightReceive(t *testing.T) {
	_, a := connectAdapter(t, Options{})
	done := make(chan voice.AudioChunk, 1)
	start := time.Now()
	go func() { done <- receive(t, a, 5*time.Second) }()
	time.Sleep(20 * time.Millisecond)
	if err := a.Live().Interrupt(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case c := <-done:
		if len(c.Data) != 0 || time.Since(start) > 3*time.Second {
			t.Fatalf("chunk = %v after %v", c.Data, time.Since(start))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("receive not woken")
	}
}

// After the spurious pair the deadline extends, so recovery audio arriving
// past the original timeout is still read in the same receive.
func TestSpuriousPairExtendsTheDeadline(t *testing.T) {
	srv, a := connectAdapter(t, Options{})
	push(t, srv, interrupted(), turnComplete())
	awaitQueued(t, a, 2)
	go func() {
		time.Sleep(600 * time.Millisecond)
		push(t, srv, audioMsg(), turnComplete())
	}()
	if c := receive(t, a, 500*time.Millisecond); len(c.Data) == 0 {
		t.Fatal("delayed recovery audio not captured")
	}
}

func TestSendAudioResamplesBetweenActivityMarkers(t *testing.T) {
	srv, a := connectAdapter(t, Options{})
	mark := srv.Len()
	if err := a.Live().SendAudio(context.Background(), tone(4800)); err != nil {
		t.Fatal(err)
	}
	srv.WaitFor(t, func(fs []realtimetest.Frame) bool { return len(fs) >= mark+3 })
	fs := srv.Frames()[mark:]
	ri := func(f realtimetest.Frame) map[string]any { m, _ := f.Data["realtimeInput"].(map[string]any); return m }
	if _, ok := ri(fs[0])["activityStart"]; !ok {
		t.Fatalf("first = %s", fs[0].Raw)
	}
	au, _ := ri(fs[1])["audio"].(map[string]any)
	data, _ := base64.StdEncoding.DecodeString(au["data"].(string))
	if au["mimeType"] != "audio/pcm;rate=16000" || len(data) != 3200 {
		t.Fatalf("audio = %v (%d bytes)", au["mimeType"], len(data))
	}
	if _, ok := ri(fs[2])["activityEnd"]; !ok {
		t.Fatalf("last = %s", fs[2].Raw)
	}
}

func TestGoAwayFailsTheReceive(t *testing.T) {
	srv, a := connectAdapter(t, Options{})
	push(t, srv, map[string]any{"goAway": map[string]any{"timeLeft": "1s"}})
	if _, err := a.Live().ReceiveAudio(context.Background(), 2*time.Second); err == nil || !strings.Contains(err.Error(), "goAway") {
		t.Fatalf("err = %v", err)
	}
}

func TestServerCloseEndsTheTurnGracefully(t *testing.T) {
	srv, a := connectAdapter(t, Options{})
	push(t, srv, map[string]any{"serverContent": map[string]any{"outputTranscription": map[string]any{"text": "bye"}}})
	awaitQueued(t, a, 1)
	srv.Close()
	c := receive(t, a, 5*time.Second)
	if len(c.Data) != 0 || c.Transcript != "bye" {
		t.Fatalf("chunk = %v %q", c.Data, c.Transcript)
	}
}

func TestOperationsBeforeConnect(t *testing.T) {
	rt := NewTransport(Options{APIKey: "k"})
	ctx := context.Background()
	if err := rt.SendAudio(ctx, tone(48)); err == nil {
		t.Fatal("send before connect")
	}
	if _, err := rt.ReceiveAudio(ctx, time.Millisecond); err == nil {
		t.Fatal("receive before connect")
	}
	if err := rt.Disconnect(ctx); err != nil {
		t.Fatal(err)
	}
	_, err := New(Options{APIKey: "k"}).Call(ctx, scenario.AgentInput{})
	if err == nil {
		t.Fatal("turn before connect")
	}
}

func TestReceiveTimesOut(t *testing.T) {
	_, a := connectAdapter(t, Options{})
	_, err := a.Live().ReceiveAudio(context.Background(), 30*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "no message within 30ms") {
		t.Fatalf("err = %v", err)
	}
}

// ---------------------------------------------------------------- spans

func byName(ss tracetest.SpanStubs) map[string]tracetest.SpanStub {
	out := map[string]tracetest.SpanStub{}
	for _, s := range ss {
		out[s.Name] = s
	}
	return out
}

func attr(s tracetest.SpanStub, key string) any {
	for _, kv := range s.Attributes {
		if string(kv.Key) == key {
			return kv.Value.AsInterface()
		}
	}
	return nil
}

func call(t *testing.T, a *Adapter, in scenario.AgentInput) error {
	t.Helper()
	_, err := a.Call(context.Background(), in)
	return err
}

const userBytes, wireBytes = 4800, 3200

func TestCallEmitsTheBaseSpansAndAGreetingSendsNothing(t *testing.T) {
	srv, a := connectAdapter(t, Options{})
	spans.Reset()
	push(t, srv, audioMsg(), turnComplete())
	u := tone(userBytes)
	if err := call(t, a, audioInput(&u)); err != nil {
		t.Fatal(err)
	}
	got := byName(spans.GetSpans())
	for _, n := range []string{voice.SpanTurn, voice.SpanAudioSend, voice.SpanAudioReceive} {
		if _, ok := got[n]; !ok {
			t.Fatalf("missing %s", n)
		}
	}
	if attr(got[voice.SpanTurn], "voice.adapter.class") != className {
		t.Fatal("class")
	}
	spans.Reset()
	push(t, srv, audioMsg(), turnComplete())
	if err := call(t, a, audioInput(nil)); err != nil {
		t.Fatal(err)
	}
	got = byName(spans.GetSpans())
	if _, ok := got[voice.SpanAudioSend]; ok {
		t.Fatal("a greeting emitted a send span")
	}
	if _, ok := got[voice.SpanTurn]; !ok {
		t.Fatal("no turn span")
	}
}

func TestSendSpanCarriesTheWireBytes(t *testing.T) {
	srv, a := connectAdapter(t, Options{})
	send := func(c voice.AudioChunk) tracetest.SpanStub {
		spans.Reset()
		ctx, span := voice.StartSpan(context.Background(), voice.SpanAudioSend)
		if err := a.Live().SendAudio(ctx, c); err != nil {
			t.Fatal(err)
		}
		voice.EndSpan(span, nil)
		return byName(spans.GetSpans())[voice.SpanAudioSend]
	}
	mark := srv.Len()
	if v := attr(send(tone(userBytes)), "voice.gemini.audio.wire_bytes"); v != int64(wireBytes) {
		t.Fatalf("wire_bytes = %v", v)
	}
	srv.WaitFor(t, func(fs []realtimetest.Frame) bool { return len(fs) >= mark+3 })
	mark = srv.Len()
	if v := attr(send(tone(2)), "voice.gemini.audio.wire_bytes"); v != int64(0) {
		t.Fatalf("empty wire_bytes = %v", v)
	}
	time.Sleep(30 * time.Millisecond)
	if srv.Len() != mark {
		t.Fatal("an empty resample sent activity markers")
	}
}

func TestReceiveSpanCountsSpuriousRetries(t *testing.T) {
	srv, a := connectAdapter(t, Options{})
	u := tone(userBytes)
	for _, k := range []int{0, 3} {
		spans.Reset()
		for range k {
			push(t, srv, interrupted(), turnComplete())
		}
		push(t, srv, audioMsg(), turnComplete())
		if err := call(t, a, audioInput(&u)); err != nil {
			t.Fatal(err)
		}
		recv := byName(spans.GetSpans())[voice.SpanAudioReceive]
		if attr(recv, "voice.gemini.spurious_retry_count") != int64(k) || attr(recv, "voice.gemini.turn_complete") != true {
			t.Fatalf("k=%d: attrs = %v", k, recv.Attributes)
		}
		var receives int
		for _, s := range spans.GetSpans() {
			if s.Name == voice.SpanAudioReceive {
				receives++
			}
		}
		if receives != 1 {
			t.Fatalf("k=%d: %d receive spans", k, receives)
		}
	}
}

func TestGoAwayOnTheFirstChunkMarksTheReceiveSpanError(t *testing.T) {
	srv, a := connectAdapter(t, Options{})
	spans.Reset()
	push(t, srv, map[string]any{"goAway": map[string]any{"reason": "server terminate"}})
	if err := call(t, a, audioInput(nil)); err == nil || !strings.Contains(strings.ToLower(err.Error()), "goaway") {
		t.Fatalf("err = %v", err)
	}
	if recv := byName(spans.GetSpans())[voice.SpanAudioReceive]; recv.Status.Code != codes.Error {
		t.Fatalf("status = %v", recv.Status)
	}
}

func TestInterruptSpanOutcome(t *testing.T) {
	interrupt := func(rt *Transport) any {
		spans.Reset()
		ctx, span := voice.StartSpan(context.Background(), voice.SpanAdapterInterrupt)
		_ = rt.Interrupt(ctx)
		voice.EndSpan(span, nil)
		return attr(byName(spans.GetSpans())[voice.SpanAdapterInterrupt], "voice.gemini.interrupt.outcome")
	}
	_, a := connectAdapter(t, Options{})
	if v := interrupt(a.Live()); v != "sentinel_fired" {
		t.Fatalf("connected outcome = %v", v)
	}
	if v := interrupt(NewTransport(Options{APIKey: "k"})); v != "no_op_not_connected" {
		t.Fatalf("unconnected outcome = %v", v)
	}
}

// The voice.* span names and voice.gemini.* attribute keys match the
// Python and JavaScript taxonomy.
func TestSpanTaxonomyParity(t *testing.T) {
	srv := realtimetest.New(t)
	a := New(Options{APIKey: "k", URL: srv.URL + "/ws"})
	a.ResponseTailSilence = 50 * time.Millisecond
	a.TranscriptGraceWait = 0
	spans.Reset()
	in := func(name string, fn func(ctx context.Context) error) {
		ctx, span := voice.StartSpan(context.Background(), name)
		err := fn(ctx)
		voice.EndSpan(span, err)
		if err != nil {
			t.Fatal(err)
		}
	}
	srv.Arm()
	in(voice.SpanAdapterConnect, a.Live().Connect)
	srv.WaitConnected(t)
	push(t, srv, audioMsg(), turnComplete())
	u := tone(userBytes)
	if err := call(t, a, audioInput(&u)); err != nil {
		t.Fatal(err)
	}
	in(voice.SpanAdapterInterrupt, a.Live().Interrupt)
	in(voice.SpanAdapterDisconnect, a.Live().Disconnect)

	names, keys := map[string]bool{}, map[string]bool{}
	for _, s := range spans.GetSpans() {
		if strings.HasPrefix(s.Name, "voice.") {
			names[s.Name] = true
		}
		for _, kv := range s.Attributes {
			if strings.HasPrefix(string(kv.Key), "voice.gemini.") {
				keys[string(kv.Key)] = true
			}
		}
	}
	sorted := func(m map[string]bool) []string {
		var out []string
		for k := range m {
			out = append(out, k)
		}
		slices.Sort(out)
		return out
	}
	if got := sorted(names); !slices.Equal(got, []string{"voice.adapter.connect", "voice.adapter.disconnect",
		"voice.adapter.interrupt", "voice.audio.receive", "voice.audio.send", "voice.turn"}) {
		t.Fatalf("span names = %v", got)
	}
	if got := sorted(keys); !slices.Equal(got, []string{"voice.gemini.audio.wire_bytes", "voice.gemini.interrupt.outcome",
		"voice.gemini.model", "voice.gemini.spurious_retry_count", "voice.gemini.turn_complete", "voice.gemini.voice"}) {
		t.Fatalf("attribute keys = %v", got)
	}
}
