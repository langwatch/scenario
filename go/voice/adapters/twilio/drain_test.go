package twilio

// Ported from twilio-silent-stop-drain.test.ts: the inbound queue ends
// cleanly on a silent or tool-only completion, through the production
// session wrapper (which drops the transport on exit) and through the real
// /twilio/stream route with the real voice turn as the consumer; plus the
// far-end hangup contract.

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
)

const recvTimeout = 2 * time.Second

func drainAdapter(t *testing.T) *Adapter {
	t.Helper()
	return connected(t, makeAdapter(t, newSpyREST(), withoutGate(), func(o *Options) {
		o.PhoneNumber, o.PublicBaseURL = "+14155556959", "https://example695.test"
	}))
}

func start695(sid, call string) string {
	return `{"event":"start","start":{"streamSid":"` + sid + `","callSid":"` + call + `"}}`
}

// scripted serves frames then closes, like the JS scriptedSocket.
func scripted(frames ...string) *fakeConn {
	c := newConn(frames...)
	c.closeAtEnd = true
	return c
}

func receiveEmptyTwice(t *testing.T, a *Adapter) {
	t.Helper()
	for i := range 2 {
		c, err := a.ReceiveAudio(context.Background(), recvTimeout)
		if err != nil || len(c.Data) != 0 {
			t.Fatalf("receive %d: %d bytes, %v", i, len(c.Data), err)
		}
	}
}

func TestStopWithNoTrailingAudioDrainsEmpty(t *testing.T) {
	a := drainAdapter(t)
	await(t, drive(t, a, scripted(start695("MZ695", "CA695"), stopFrame), true))
	if streamConnOf(a) != nil || state(a, func(a *Adapter) string { return a.streamSID }) != "" {
		t.Fatal("production teardown did not drop the transport")
	}
	receiveEmptyTwice(t, a)
}

func TestSocketCloseMidStreamDrainsEmpty(t *testing.T) {
	a := drainAdapter(t)
	await(t, drive(t, a, scripted(start695("MZ695", "CA695")), true))
	receiveEmptyTwice(t, a)
}

func TestTrailingAudioSurvivesTeardownAheadOfTheSentinel(t *testing.T) {
	a := drainAdapter(t)
	await(t, drive(t, a, scripted(start695("MZ695", "CA695"), mediaFrame("MZ695", bytes.Repeat([]byte{0x7f}, 160)), stopFrame), true))
	c, err := a.ReceiveAudio(context.Background(), recvTimeout)
	if err != nil || len(c.Data) == 0 {
		t.Fatalf("first chunk %d bytes, %v", len(c.Data), err)
	}
	if c, err = a.ReceiveAudio(context.Background(), recvTimeout); err != nil || len(c.Data) != 0 {
		t.Fatalf("second chunk %d bytes, %v", len(c.Data), err)
	}
}

func TestTransportErrorDrainsEmpty(t *testing.T) {
	a := drainAdapter(t)
	c := newConn()
	session := result(func() error { return a.runStreamSession(c) })
	c.pushFrame(start695("MZ695", "CA695"))
	c.push(item{err: errors.New("boom: transport failure")})
	if err := await(t, session); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("session err %v", err)
	}
	if streamConnOf(a) != nil {
		t.Fatal("transport not dropped")
	}
	receiveEmptyTwice(t, a)
}

func TestSecondSessionDoesNotInheritTheEndedFlag(t *testing.T) {
	a := drainAdapter(t)
	await(t, drive(t, a, scripted(start695("MZ695", "CA695"), stopFrame), true))
	if c, _ := a.ReceiveAudio(context.Background(), recvTimeout); len(c.Data) != 0 {
		t.Fatal("session 1 sentinel")
	}
	c := newConn()
	session2 := result(func() error { return a.runStreamSession(c) })
	c.pushFrame(start695("MZ695b", "CA695b"))
	waitUntil(t, func() bool { return streamConnOf(a) != nil }, "session 2 to adopt")
	audioCh := make(chan int, 1)
	go func() {
		chunk, _ := a.ReceiveAudio(context.Background(), recvTimeout)
		audioCh <- len(chunk.Data)
	}()
	time.Sleep(20 * time.Millisecond)
	c.pushFrame(mediaFrame("MZ695b", bytes.Repeat([]byte{0x7f}, 800)))
	if n := <-audioCh; n == 0 {
		t.Fatal("the new call's first turn was served a stale sentinel")
	}
	c.pushFrame(stopFrame)
	await(t, session2)
	if chunk, _ := a.ReceiveAudio(context.Background(), recvTimeout); len(chunk.Data) != 0 {
		t.Fatal("tail")
	}
}

// Real-route tests: a real WebSocket client on /twilio/stream and the real
// voice turn as consumer. A fix that only works through the session wrapper
// by name cannot pass here.

func routeClient(t *testing.T, a *Adapter) *twilioClient {
	t.Helper()
	c, err := dialStream(t, a, "/twilio/stream")
	if err != nil {
		t.Fatal(err)
	}
	c.send(start695("MZ695", "CA695"))
	waitUntil(t, func() bool { return state(a, func(a *Adapter) string { return a.streamSID }) == "MZ695" }, "the start frame")
	return c
}

func awaitTeardown(t *testing.T, a *Adapter) {
	t.Helper()
	waitUntil(t, func() bool { return streamConnOf(a) == nil }, "the route's teardown")
}

// turnAsync runs one agent turn in the background.
func turnAsync(t *testing.T, ag *voice.Agent) chan int {
	ch := make(chan int, 1)
	go func() {
		msgs, err := ag.Turn(context.Background(), scenario.AgentInput{})
		if err != nil {
			t.Errorf("turn failed: %v", err)
		}
		ch <- audioBytes(msgs)
	}()
	return ch
}

func TestRouteSilentStopMidDrain(t *testing.T) {
	a := drainAdapter(t)
	client := routeClient(t, a)
	call := turnAsync(t, agentFor(a, 500*time.Millisecond))
	time.Sleep(50 * time.Millisecond)
	client.send(stopFrame)
	if n := <-call; n != 0 {
		t.Fatalf("%d bytes", n)
	}
	awaitTeardown(t, a)
}

func TestRouteSocketCloseMidDrain(t *testing.T) {
	a := drainAdapter(t)
	client := routeClient(t, a)
	call := turnAsync(t, agentFor(a, 500*time.Millisecond))
	time.Sleep(50 * time.Millisecond)
	client.close()
	if n := <-call; n != 0 {
		t.Fatalf("%d bytes", n)
	}
	awaitTeardown(t, a)
}

func TestRouteTrailingAudioSurvivesTeardown(t *testing.T) {
	a := drainAdapter(t)
	client := routeClient(t, a)
	call := turnAsync(t, agentFor(a, 500*time.Millisecond))
	time.Sleep(50 * time.Millisecond)
	client.send(mediaFrame("MZ695", bytes.Repeat([]byte{0x7f}, 160)))
	client.send(stopFrame)
	if n := <-call; n == 0 {
		t.Fatal("audio never reached the drain")
	}
	awaitTeardown(t, a)
}

func TestRouteTurnAfterHangupDrainsCleanly(t *testing.T) {
	a := drainAdapter(t)
	client := routeClient(t, a)
	client.send(stopFrame)
	awaitTeardown(t, a)
	if n := audioBytes(driveCall(t, agentFor(a, 500*time.Millisecond), voice.AudioChunk{})); n != 0 {
		t.Fatalf("%d bytes", n)
	}
}

func TestRouteUndrainedSentinelDoesNotTruncateTheNextCall(t *testing.T) {
	a := drainAdapter(t)
	first := routeClient(t, a)
	first.send(stopFrame)
	awaitTeardown(t, a)
	first.close()

	second := routeClient(t, a)
	ag := agentFor(a, 200*time.Millisecond)
	call := turnAsync(t, ag)
	time.Sleep(600 * time.Millisecond)
	second.send(mediaFrame("MZ695", bytes.Repeat([]byte{0x7f}, 800)))
	if n := <-call; n == 0 {
		t.Fatal("a stale sentinel truncated the new call's first turn")
	}
}

func TestRouteAudioBufferedBeforeHangupIsNotLost(t *testing.T) {
	a := drainAdapter(t)
	client := routeClient(t, a)
	client.send(mediaFrame("MZ695", bytes.Repeat([]byte{0x7f}, 160)))
	client.send(stopFrame)
	awaitTeardown(t, a)
	if n := audioBytes(driveCall(t, agentFor(a, 500*time.Millisecond), voice.AudioChunk{})); n == 0 {
		t.Fatal("audio buffered before the hangup was lost")
	}
}

// Far-end hangup.

func TestRemoteStopIsAHangup(t *testing.T) {
	a := drainAdapter(t)
	await(t, drive(t, a, scripted(start695("MZ695", "CA695"), stopFrame), true))
	if a.IsConnected() || !a.AgentHungUp() {
		t.Fatalf("connected %v hung up %v", a.IsConnected(), a.AgentHungUp())
	}
	if err := a.SendAudio(context.Background(), voice.AudioChunk{Data: make([]byte, 320)}); err != nil {
		t.Fatalf("SendAudio after a hangup must be a quiet no-op: %v", err)
	}
}

func TestLocalDisconnectIsNotAHangup(t *testing.T) {
	a := makeAdapter(t, newSpyREST(), withoutGate())
	if err := a.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	c := newConn()
	session := result(func() error { return a.runStreamSession(c) })
	c.pushFrame(start695("MZ695", "CA695"))
	waitUntil(t, func() bool { return streamConnOf(a) != nil }, "adoption")
	// Disconnect closes the live socket itself; the loop sees the close.
	if err := a.Disconnect(context.Background()); err != nil {
		t.Fatal(err)
	}
	await(t, session)
	if a.IsConnected() || a.AgentHungUp() {
		t.Fatalf("connected %v hung up %v", a.IsConnected(), a.AgentHungUp())
	}
}

func TestBufferedFarewellDrainsThenTheNextTurnConcludes(t *testing.T) {
	a := drainAdapter(t)
	await(t, drive(t, a, scripted(start695("MZ695", "CA695"), mediaFrame("MZ695", bytes.Repeat([]byte{0x7f}, 160)), stopFrame), true))
	if !a.AgentHungUp() || !a.IsConnected() {
		t.Fatal("a queued farewell must keep the transport connected")
	}
	ag := agentFor(a, 500*time.Millisecond)
	if n := audioBytes(driveCall(t, ag, voice.AudioChunk{})); n == 0 {
		t.Fatal("farewell lost")
	}
	if a.IsConnected() {
		t.Fatal("still connected with nothing left to drain")
	}
	if msgs := driveCall(t, ag, voice.AudioChunk{}); len(msgs) != 0 {
		t.Fatalf("leftover turn produced %v", msgs)
	}
}

func TestNeverPlacedSendAudioFails(t *testing.T) {
	a := drainAdapter(t)
	err := a.SendAudio(context.Background(), voice.AudioChunk{Data: make([]byte, 320)})
	if err == nil || err.Error() != "TwilioAgentAdapter: no live media stream. Call placeCall() or waitForCall() first." {
		t.Fatalf("err %v", err)
	}
}

func TestReceiveTimeoutWrapsErrReceiveTimeout(t *testing.T) {
	a := drainAdapter(t)
	drive(t, a, newConn(start695("MZ695", "CA695")), false)
	_, err := a.ReceiveAudio(context.Background(), 10*time.Millisecond)
	if !errors.Is(err, voice.ErrReceiveTimeout) || !strings.Contains(err.Error(), "no audio received within 10ms") {
		t.Fatalf("err %v", err)
	}
}
