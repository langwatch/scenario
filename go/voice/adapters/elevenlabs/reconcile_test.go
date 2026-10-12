package elevenlabs

import (
	"bytes"
	"context"
	"math"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/voice"
	"github.com/langwatch/scenario/go/voice/voicetest"
)

// Hosted ElevenLabs delivers a turn's audio in a near-instant burst. When a
// turn's drain stops at its ceiling, the rest of the burst stays queued; the
// next user turn must reconcile it into the previous agent segment rather
// than let it surface as the fake start of the next agent turn (#747).

func TestReconcilePendingAudioMergesTheQueue(t *testing.T) {
	t.Parallel()
	f := newFake(t)
	tr := f.connect(f.options("agt"))
	if _, ok := tr.ReconcilePendingAudio(); ok {
		t.Fatal("an empty queue reconciled audio")
	}
	f.emit(audioEvent([]byte{1, 1}))
	f.emit(audioEvent([]byte{2, 2, 3, 3}))
	f.sync()
	c, ok := tr.ReconcilePendingAudio()
	if !ok || !bytes.Equal(c.Data, []byte{1, 1, 2, 2, 3, 3}) {
		t.Fatalf("reconciled %v %v", c.Data, ok)
	}
	if _, ok := tr.ReconcilePendingAudio(); ok {
		t.Fatal("the queue was not drained")
	}
}

func TestBurstRemainderDoesNotBleedIntoTheNextTurn(t *testing.T) {
	t.Parallel()
	f := newFake(t)
	a := must(NewAgent(f.options("agt-burst")))
	// A generous first-chunk budget: the fake answers once it sees the
	// commit, which a loaded machine may take a while to schedule.
	a.ResponseTimeout = 10 * time.Second
	a.ResponseTailSilence = 100 * time.Millisecond
	a.ResponseMaxDuration = 500 * time.Millisecond // the drain stops at 1s
	a.TranscriptGraceWait = 0

	// The fake agent answers each user turn once its speech reaches the
	// wire: the first with a 1.5s burst, the second with 0.2s. The burst's
	// first chunk alone reaches the drain's 1s ceiling, so the drain stops
	// without waiting on the wall clock and the 0.5s remainder stays queued.
	replies := [][]voice.AudioChunk{
		{voicetest.Tone(1.0, ""), voicetest.Tone(0.5, "")},
		{voicetest.Tone(0.2, "")},
	}
	emitted := []chan struct{}{make(chan struct{}), make(chan struct{})}
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		for turn := 0; turn < len(replies); {
			select {
			case <-stop:
				return
			case <-time.After(5 * time.Millisecond):
			}
			if a.ConvAI().AudioCommitCount() <= turn {
				continue
			}
			for _, c := range replies[turn] {
				data, _ := encodeJSON(audioEvent(c.Data))
				_ = f.tryEmit(data)
			}
			close(emitted[turn])
			turn++
		}
	}()
	// The next user turn starts only once the whole burst is queued at the
	// transport, as with a hosted agent whose burst is near-instant.
	burstQueued := scenario.StepFunc(func(context.Context, *scenario.Executor) error {
		select {
		case <-emitted[0]:
		case <-time.After(10 * time.Second):
			t.Fatal("the fake never sent the burst")
		}
		f.sync()
		return nil
	})

	res, err := scenario.Run(context.Background(), scenario.ScenarioConfig{
		Name: "burst", Description: "burst",
		Agents: []scenario.AgentAdapter{a, &voicetest.User{}, &voicetest.Judge{Verdict: voicetest.Pass()}},
		Script: []scenario.ScriptStep{scenario.User(), scenario.Agent(), burstQueued, scenario.User(), scenario.Agent(), scenario.Succeed()},
	}, voice.WithConfig(voice.Config{STT: &voicetest.STT{}, Logger: quietLogger()}), scenario.WithQuiet())
	if err != nil {
		t.Fatal(err)
	}
	segs := voice.ResultOf(res).Recording.Segments
	if len(segs) != 4 {
		t.Fatalf("%d segments", len(segs))
	}
	first, second := segs[1], segs[3]
	if first.Speaker != voice.SpeakerAgent || math.Abs(first.EndTime-first.StartTime-1.5) > 1e-6 || !first.TranscriptTruncated {
		t.Fatalf("the burst remainder was not attributed to its turn: %.3fs", first.EndTime-first.StartTime)
	}
	if d := second.EndTime - second.StartTime; math.Abs(d-0.2) > 1e-6 {
		t.Fatalf("the second agent turn carries %.3fs, want only its own 0.2s", d)
	}
}
