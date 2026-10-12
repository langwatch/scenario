package twilio

// The shared a-leg test harness, ported from a-leg-harness.ts: a REST spy,
// an adapter factory, scripted and controllable media sockets, and the ways
// to drive them. One socket double and one REST spy for every suite, so the
// originated call SID cannot drift between files.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

var spans = tracetest.NewInMemoryExporter()

func TestMain(m *testing.M) {
	otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sdktrace.NewSimpleSpanProcessor(spans))))
	os.Exit(m.Run())
}

const (
	// originatedCallSID is the call the REST spy says a-leg originated.
	originatedCallSID = "CA11111111111111111111111111111111"
	// aLegDestination is Ofcom's drama range: permanently unassignable, so a
	// copy-paste into a live config dials nobody.
	aLegDestination = "+447700900123"
	phoneSID        = "PN1234567890abcdef"
)

var nonceRE = regexp.MustCompile(`<Parameter name="nonce" value="([^"]+)"/>`)

type restCall struct {
	op   string
	args []string
}

// spyREST records every REST call; the hooks override behaviour.
type spyREST struct {
	mu            sync.Mutex
	log           []restCall
	placeCalls    []PlaceCallParams
	endCalls      []string
	dtmfCalls     [][2]string
	priorVoiceURL string
	resolveErr    error
	placeCall     func(PlaceCallParams) (string, error)
	endCall       func(string) error
	writeVoiceURL func(sid, url string) error
}

func newSpyREST() *spyREST { return &spyREST{} }

func (s *spyREST) record(op string, args ...string) {
	s.mu.Lock()
	s.log = append(s.log, restCall{op, args})
	s.mu.Unlock()
}

func (s *spyREST) ResolvePhoneNumberSID(_ context.Context, n string) (string, error) {
	s.record("resolvePhoneNumberSid", n)
	if s.resolveErr != nil {
		return "", s.resolveErr
	}
	return phoneSID, nil
}

func (s *spyREST) ReadVoiceURL(_ context.Context, sid string) (string, error) {
	s.record("readVoiceUrl", sid)
	return s.priorVoiceURL, nil
}

func (s *spyREST) WriteVoiceURL(_ context.Context, sid, url string) error {
	s.record("writeVoiceUrl", sid, url)
	if s.writeVoiceURL != nil {
		return s.writeVoiceURL(sid, url)
	}
	return nil
}

func (s *spyREST) PlaceCall(_ context.Context, p PlaceCallParams) (string, error) {
	s.mu.Lock()
	s.placeCalls = append(s.placeCalls, p)
	hook := s.placeCall
	s.mu.Unlock()
	if hook != nil {
		return hook(p)
	}
	return originatedCallSID, nil
}

func (s *spyREST) EndCall(_ context.Context, sid string) error {
	s.mu.Lock()
	s.endCalls = append(s.endCalls, sid)
	hook := s.endCall
	s.mu.Unlock()
	if hook != nil {
		return hook(sid)
	}
	return nil
}

func (s *spyREST) SendDTMF(_ context.Context, sid, tones string) error {
	s.mu.Lock()
	s.dtmfCalls = append(s.dtmfCalls, [2]string{sid, tones})
	s.mu.Unlock()
	return nil
}

func (s *spyREST) logSince(n int) []restCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.log[n:])
}

func (s *spyREST) logLen() int { s.mu.Lock(); defer s.mu.Unlock(); return len(s.log) }

func (s *spyREST) places() []PlaceCallParams {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.placeCalls)
}

func (s *spyREST) ends() []string { s.mu.Lock(); defer s.mu.Unlock(); return slices.Clone(s.endCalls) }

func (s *spyREST) dtmf() [][2]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.dtmfCalls)
}

// adapterOpt tweaks the factory's options.
type adapterOpt func(*Options)

func withCallees(c ...string) adapterOpt { return func(o *Options) { o.AllowedCallees = c } }
func withoutGate() adapterOpt            { return func(o *Options) { o.DisableSpeechGate = true } }
func withReadiness(r TunnelReadiness) adapterOpt {
	return func(o *Options) { o.TunnelReadiness = r }
}

// makeAdapter builds an SDK-owned adapter over rest. AllowedCallees default
// to the one a-leg destination: a-leg is deny-by-default and every a-leg
// test needs it.
func makeAdapter(t *testing.T, rest REST, opts ...adapterOpt) *Adapter {
	t.Helper()
	o := Options{
		AccountSID: "ACtest", AuthToken: "secret", PhoneNumber: "+14155551234",
		PublicBaseURL: "https://example.test", SkipSignatureValidation: true,
		AllowedCallees: []string{aLegDestination}, REST: rest,
	}
	for _, f := range opts {
		f(&o)
	}
	a, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

// connected connects a and disconnects it at the end of the test.
func connected(t *testing.T, a *Adapter) *Adapter {
	t.Helper()
	if err := a.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Disconnect(context.Background()) })
	return a
}

type startOpts struct {
	nonce, callSID, streamSID string
}

// startFrame is an inbound start frame; the call SID defaults to the
// originated one and the stream SID to MZ762.
func startFrame(o startOpts) string {
	start := map[string]any{"streamSid": "MZ762", "callSid": originatedCallSID}
	if o.streamSID != "" {
		start["streamSid"] = o.streamSID
	}
	if o.callSID != "" {
		start["callSid"] = o.callSID
	}
	if o.nonce != "" {
		start["customParameters"] = map[string]string{"nonce": o.nonce}
	}
	b, _ := json.Marshal(map[string]any{"event": "start", "start": start})
	return string(b)
}

// mediaFrame is an inbound media frame, built here rather than by the
// adapter's encoder so an encoder bug cannot cancel a decoder bug.
func mediaFrame(streamSID string, payload []byte) string {
	b, _ := json.Marshal(map[string]any{"event": "media", "streamSid": streamSID,
		"media": map[string]string{"payload": base64.StdEncoding.EncodeToString(payload)}})
	return string(b)
}

const stopFrame = `{"event":"stop"}`

func dtmfFrame(digit string) string {
	return `{"event":"dtmf","streamSid":"MZ775","dtmf":{"digit":"` + digit + `"}}`
}

// item is one scripted read: a frame, a clean close (eof) or a failure.
type item struct {
	frame string
	eof   bool
	err   error
}

// fakeConn is the media socket double. Scripted frames are served in order;
// then it parks (a socket Twilio holds open), returns io.EOF (closeAtEnd:
// the client hung up) or serves whatever push() delivers. Close marks it
// closed and ends a parked read with io.EOF.
type fakeConn struct {
	mu         sync.Mutex
	queue      []item
	closeAtEnd bool
	gate       chan struct{}
	gated      bool
	more       chan struct{}
	parked     chan struct{}
	parkOnce   sync.Once
	closedCh   chan struct{}
	closeOnce  sync.Once
	sent       [][]byte
	isClosed   bool
}

func newConn(frames ...string) *fakeConn {
	c := &fakeConn{more: make(chan struct{}, 1), parked: make(chan struct{}), closedCh: make(chan struct{})}
	for _, f := range frames {
		c.queue = append(c.queue, item{frame: f})
	}
	return c
}

// push delivers one more read to a controllable socket.
func (c *fakeConn) push(it item) {
	c.mu.Lock()
	c.queue = append(c.queue, it)
	c.mu.Unlock()
	select {
	case c.more <- struct{}{}:
	default:
	}
}

func (c *fakeConn) pushFrame(f string) { c.push(item{frame: f}) }

func (c *fakeConn) ReadFrame(ctx context.Context) ([]byte, bool, error) {
	if c.gate != nil && !c.gated {
		c.gated = true
		select {
		case <-c.gate:
		case <-c.closedCh:
			return nil, false, io.EOF
		}
	}
	for {
		c.mu.Lock()
		if len(c.queue) > 0 {
			it := c.queue[0]
			c.queue = c.queue[1:]
			c.mu.Unlock()
			switch {
			case it.err != nil:
				return nil, false, it.err
			case it.eof:
				return nil, false, io.EOF
			}
			return []byte(it.frame), false, nil
		}
		c.mu.Unlock()
		c.parkOnce.Do(func() { close(c.parked) })
		if c.closeAtEnd {
			return nil, false, io.EOF
		}
		select {
		case <-c.more:
		case <-c.closedCh:
			return nil, false, io.EOF
		case <-ctx.Done():
			return nil, false, io.EOF
		}
	}
}

func (c *fakeConn) WriteText(_ context.Context, p []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sent = append(c.sent, bytes.Clone(p))
	return nil
}

func (c *fakeConn) Close() {
	c.mu.Lock()
	c.isClosed = true
	c.mu.Unlock()
	c.closeOnce.Do(func() { close(c.closedCh) })
}

func (c *fakeConn) closed() bool { c.mu.Lock(); defer c.mu.Unlock(); return c.isClosed }

func (c *fakeConn) sentFrames() [][]byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Clone(c.sent)
}

// drive runs the media stream over c until the loop returns or c parked,
// leaving it running; production drives the full session wrapper (which
// drops the transport on exit) instead of the bare loop. The returned
// channel yields the loop's error.
func drive(t *testing.T, a *Adapter, c *fakeConn, production bool) chan error {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		if production {
			done <- a.runStreamSession(c)
		} else {
			done <- a.mediaStreamLoop(context.Background(), c)
		}
	}()
	select {
	case err := <-done:
		done <- err
	case <-c.parked:
	case <-time.After(5 * time.Second):
		t.Fatal("media stream neither settled nor consumed its scripted frames")
	}
	return done
}

// result runs fn in the background and returns its error channel.
func result(fn func() error) chan error {
	ch := make(chan error, 1)
	go func() { ch <- fn() }()
	return ch
}

// await waits for a background call to finish.
func await(t *testing.T, ch chan error) error {
	t.Helper()
	select {
	case err := <-ch:
		return err
	case <-time.After(10 * time.Second):
		t.Fatal("call never returned")
		return nil
	}
}

// isPending reports whether ch has not delivered within 20 ms.
func isPending(ch chan error) bool {
	select {
	case err := <-ch:
		ch <- err
		return false
	case <-time.After(20 * time.Millisecond):
		return true
	}
}

// waitUntil polls pred.
func waitUntil(t *testing.T, pred func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !pred() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// startALegCall starts an a-leg PlaceCall without waiting for it and
// returns the nonce its TwiML carries and the pending call. The call only
// returns once a socket authenticates, so it is the stream-connected
// signal.
func startALegCall(t *testing.T, a *Adapter, rest *spyREST) (string, chan error) {
	t.Helper()
	n := len(rest.places())
	call := result(func() error {
		return a.PlaceCall(context.Background(), CallOptions{To: aLegDestination, Attach: AttachALeg, Timeout: 10 * time.Second})
	})
	waitUntil(t, func() bool { return len(rest.places()) > n }, "the origination REST call")
	m := nonceRE.FindStringSubmatch(rest.places()[len(rest.places())-1].TwiML)
	if m == nil {
		t.Fatal("a-leg origination TwiML carries no nonce Parameter")
	}
	return m[1], call
}

// fireConnected resolves the current stream-connected signal.
func fireConnected(a *Adapter) {
	a.mu.Lock()
	sig := a.streamConnected
	a.mu.Unlock()
	sig.fire()
}

// dialAndConnect runs a dial and fires the stream-connected signal once the
// dial has reset it and begun waiting: for tests that need the dial to
// complete without a real socket.
func dialAndConnect(t *testing.T, a *Adapter, dial func() error) error {
	t.Helper()
	ch := result(dial)
	for {
		select {
		case err := <-ch:
			return err
		case <-time.After(time.Millisecond):
			fireConnected(a)
		}
	}
}

// state reads adapter state under its lock.
func state[T any](a *Adapter, f func(*Adapter) T) T {
	a.mu.Lock()
	defer a.mu.Unlock()
	return f(a)
}

func streamConnOf(a *Adapter) any {
	return state(a, func(a *Adapter) any {
		if a.streamConn == nil {
			return nil
		}
		return a.streamConn
	})
}

// agentFor wraps a in a voice agent with short turn timings.
func agentFor(a *Adapter, tail time.Duration) *voice.Agent {
	ag := voice.NewAgent(a)
	ag.ResponseTimeout = 5 * time.Second
	ag.ResponseTailSilence = tail
	ag.TranscriptGraceWait = 0
	return ag
}

// driveCall runs one agent turn, sending incoming first when it has audio.
func driveCall(t *testing.T, ag *voice.Agent, incoming voice.AudioChunk) []scenario.Message {
	t.Helper()
	in := scenario.AgentInput{}
	if len(incoming.Data) > 0 {
		in.NewMessages = []scenario.Message{voice.AudioMessage(incoming, scenario.RoleUser)}
	}
	msgs, err := ag.Turn(context.Background(), in)
	if err != nil {
		t.Fatalf("turn failed: %v", err)
	}
	return msgs
}

func audioBytes(msgs []scenario.Message) int {
	if len(msgs) == 0 {
		return 0
	}
	c, _ := voice.ExtractAudio(msgs[0])
	return len(c.Data)
}

// withSpan runs fn under a span named like the runtime's, so attributes the
// adapter stamps on trace.SpanFromContext land on it.
func withSpan(name string, fn func(ctx context.Context) error) error {
	ctx, span := voice.StartSpan(context.Background(), name)
	err := fn(ctx)
	voice.EndSpan(span, err)
	return err
}

// twilioClient is a fake Twilio over a real WebSocket: it dials the
// adapter's media-stream route and sends frames the way Twilio does.
type twilioClient struct {
	t *testing.T
	c *websocket.Conn
}

// dialStream connects to path (such as "/twilio/stream") on a's local
// server.
func dialStream(t *testing.T, a *Adapter, path string) (*twilioClient, error) {
	t.Helper()
	base, err := a.LocalBaseURL()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(base, "http")+path, nil)
	if err != nil {
		return nil, err
	}
	tc := &twilioClient{t: t, c: c}
	t.Cleanup(func() { _ = c.CloseNow() })
	return tc, nil
}

func (c *twilioClient) send(frame string) {
	if err := c.c.Write(context.Background(), websocket.MessageText, []byte(frame)); err != nil {
		c.t.Errorf("client send: %v", err)
	}
}

// sendQuiet sends without failing the test (the socket may be gone).
func (c *twilioClient) sendQuiet(frame string) error {
	return c.c.Write(context.Background(), websocket.MessageText, []byte(frame))
}

// read returns the next frame the adapter sent, or an error once closed.
func (c *twilioClient) read(timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	_, b, err := c.c.Read(ctx)
	return string(b), err
}

func (c *twilioClient) close() { _ = c.c.Close(websocket.StatusNormalClosure, "") }

// scenarioInput is an agent input carrying incoming user audio.
func scenarioInput(incoming voice.AudioChunk) scenario.AgentInput {
	return scenario.AgentInput{NewMessages: []scenario.Message{voice.AudioMessage(incoming, scenario.RoleUser)}}
}
