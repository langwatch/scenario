package twilio

// Ported from twilio-speech-gate-turn-end.test.ts: on a continuously
// streaming phone line, the drain's tail-silence turn end must fire while
// silent frames keep arriving. The real route, a real WebSocket client and
// the real voice turn, with frames flowing at wall-clock pace. The gate's
// own admit/drop unit tests (twilio-speech-gate.test.ts) live in
// voice/vad/gate_test.go.

import (
	"math"
	"sync"
	"testing"
	"time"

	"github.com/langwatch/scenario/go/voice/audio"
)

const (
	gateFrameMs   = 100
	gateTail      = 500 * time.Millisecond
	gateFrameSize = mediastream8k * gateFrameMs / 1000
	mediastream8k = 8000
)

// mulawTone is 100 ms of a 440 Hz µ-law sine at the given int16 RMS.
func mulawTone(r float64) []byte {
	pcm := make([]byte, 2*gateFrameSize)
	amp := r * math.Sqrt2
	for i := range gateFrameSize {
		audio.PutSample(pcm, i, int16(jsRound(amp*math.Sin(2*math.Pi*440*float64(i)/mediastream8k))))
	}
	return audio.AppendMulaw(nil, pcm)
}

var (
	noiseFrame  = mulawTone(600)
	speechFrame = mulawTone(1700)
)

func gateRoute(t *testing.T, opts ...adapterOpt) (*Adapter, *twilioClient) {
	t.Helper()
	opts = append([]adapterOpt{func(o *Options) { o.PhoneNumber, o.PublicBaseURL = "+14155558014", "https://example8014.test" }}, opts...)
	a := connected(t, makeAdapter(t, newSpyREST(), opts...))
	c, err := dialStream(t, a, "/twilio/stream")
	if err != nil {
		t.Fatal(err)
	}
	c.send(start695("MZ8014", "CA8014"))
	waitUntil(t, func() bool { return state(a, func(a *Adapter) string { return a.streamSID }) == "MZ8014" }, "the start frame")
	return a, c
}

// stream keeps frame flowing every 100 ms, like Twilio, until stopped.
func stream(c *twilioClient, frame []byte) (stop func()) {
	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		tick := time.NewTicker(gateFrameMs * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-done:
				return
			case <-tick.C:
				_ = c.sendQuiet(mediaFrame("MZ8014", frame))
			}
		}
	}()
	var once sync.Once
	return func() { once.Do(func() { close(done); wg.Wait() }) }
}

func speak(c *twilioClient, frames int) {
	for range frames {
		_ = c.sendQuiet(mediaFrame("MZ8014", speechFrame))
		time.Sleep(gateFrameMs * time.Millisecond)
	}
}

func TestGateEndsTheTurnWhileSilentFramesKeepArriving(t *testing.T) {
	t.Parallel()
	a, c := gateRoute(t)
	stopNoise := stream(c, noiseFrame)
	defer stopNoise()
	call := turnAsync(t, agentFor(a, gateTail))
	time.Sleep(600 * time.Millisecond)
	speak(c, 10)
	spokeUntil := time.Now()
	n := <-call
	endedAfter := time.Since(spokeUntil)
	if n == 0 || endedAfter >= 2500*time.Millisecond {
		t.Fatalf("turn carried %d bytes and ended %v after the callee stopped", n, endedAfter)
	}
	g := state(a, func(a *Adapter) [2]int { return [2]int{a.gate.Onsets, a.gate.DroppedChunks} })
	if g[0] != 1 || g[1] == 0 {
		t.Fatalf("onsets %d, dropped %d", g[0], g[1])
	}
}

func TestWithoutTheGateTheTurnNeverReachesTailSilence(t *testing.T) {
	t.Parallel()
	a, c := gateRoute(t, withoutGate())
	if a.gate != nil {
		t.Fatal("gate present although disabled")
	}
	stopNoise := stream(c, noiseFrame)
	call := turnAsync(t, agentFor(a, gateTail))
	time.Sleep(300 * time.Millisecond)
	speak(c, 10)
	select {
	case <-call:
		t.Fatal("the ungated turn ended while frames kept arriving")
	case <-time.After(2 * time.Second):
	}
	stopNoise()
	if n := <-call; n == 0 {
		t.Fatal("no audio")
	}
}

func TestSecondTurnGetsItsOwnOnset(t *testing.T) {
	t.Parallel()
	a, c := gateRoute(t)
	stopNoise := stream(c, noiseFrame)
	defer stopNoise()
	ag := agentFor(a, gateTail)
	for turn := 1; turn <= 2; turn++ {
		call := turnAsync(t, ag)
		time.Sleep(300 * time.Millisecond)
		speak(c, 5)
		if n := <-call; n == 0 {
			t.Fatalf("turn %d carried no audio", turn)
		}
		if onsets := state(a, func(a *Adapter) int { return a.gate.Onsets }); onsets != turn {
			t.Fatalf("turn %d: %d onsets", turn, onsets)
		}
	}
}
