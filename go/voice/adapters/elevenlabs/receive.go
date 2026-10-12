package elevenlabs

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"github.com/langwatch/scenario/go/voice"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

const (
	// keepaliveHardCeiling is the floor of a receive's absolute ceiling.
	// ElevenLabs keeps pinging indefinitely on a turn it will never answer
	// with audio, and pings re-arm the idle deadline, so without a ceiling
	// such a receive would wedge the run.
	keepaliveHardCeiling = 45 * time.Second
	// lateTimerWarn is how far past due a deadline may fire before the
	// stall of the host is worth a warning.
	lateTimerWarn = time.Second
	// receiveTimeoutDocs explains both receive timeouts.
	receiveTimeoutDocs = "https://scenario.langwatch.ai/voice/troubleshooting#receiveaudio-timed-out-hosted-elevenlabs"
)

// isTurnActivity reports the frame types that still mean "the agent's turn
// is in progress" once it has spoken: more audio, or the agent working a
// tool between two spoken parts. Pings, VAD scores, context usage, text
// parts and debug events are liveness, not speech, so they do not keep the
// tail probe open.
func isTurnActivity(etype string) bool {
	switch etype {
	case evAudio, evAgentToolRequest, evAgentToolResponse, evMCPToolCall:
		return true
	}
	return false
}

// ReceiveTimeoutError is the error of a receive that ended on one of its
// deadlines. It wraps voice.ErrReceiveTimeout.
type ReceiveTimeoutError struct {
	// Ceiling is true for the absolute ceiling (frames kept arriving, but
	// never audio), false for the idle deadline (nothing arrived at all).
	Ceiling bool
	msg     string
}

func (e *ReceiveTimeoutError) Error() string { return e.msg }

// Unwrap returns voice.ErrReceiveTimeout.
func (e *ReceiveTimeoutError) Unwrap() error { return voice.ErrReceiveTimeout }

// seconds formats d the way JavaScript prints a number of seconds.
func seconds(d time.Duration) string { return strconv.FormatFloat(d.Seconds(), 'f', -1, 64) }

func idleTimeoutError(budget time.Duration) error {
	s := seconds(budget)
	return &ReceiveTimeoutError{msg: AdapterName + ": receiveAudio timed out. The idle deadline of " + s + "s " +
		"elapsed with no message of any kind from the hosted agent, not even a keepalive " +
		"ping. For a scripted multi-turn run this usually means the agent ended or " +
		"transferred its turn (e.g. an escalation/handoff request), or the user turn did " +
		"not commit. If the agent is only slower than that, raise the agent's " +
		"ResponseTimeout, currently " + s + "s, for example agent.ResponseTimeout = 180 * time.Second. " +
		"See " + receiveTimeoutDocs}
}

func ceilingTimeoutError(timeout, ceiling, floor time.Duration) error {
	f := seconds(floor)
	return &ReceiveTimeoutError{Ceiling: true, msg: AdapterName + ": receiveAudio timed out. The absolute ceiling of " +
		seconds(ceiling) + "s elapsed while the hosted agent kept sending frames, keepalive pings or transcripts, " +
		"but never audio. Until the agent speaks, and while a tool turn is open, every inbound frame " +
		"(keepalive pings included) re-arms the idle deadline, so this ceiling, " +
		"max(ResponseTimeout, " + f + "s), is what bounds the wait. It usually " +
		"means a wedged server tool or retrieval call, or an agent that ended or " +
		"transferred its turn. If the agent is only slower than that, raise the agent's " +
		"ResponseTimeout, currently " + seconds(timeout) + "s, past " + f + "s and the ceiling rises with it, " +
		"for example agent.ResponseTimeout = 180 * time.Second. " +
		"See " + receiveTimeoutDocs}
}

// receiveWait is one parked ReceiveAudio. Its fields are guarded by the
// transport's mutex.
type receiveWait struct {
	ch    chan voice.AudioChunk // buffered 1; the delivered chunk
	rearm chan struct{}         // buffered 1; the idle deadline moved
	done  bool                  // a chunk was delivered

	timeout, toolBudget, idleBudget time.Duration
	started, idleArmedAt            time.Time
	sawInbound                      bool
	framesByType                    map[string]int
}

// onFrame counts an inbound frame and decides whether it re-arms the idle
// deadline: every frame does until the agent spoke this turn, or while a
// tool turn it started is open (then on the response budget); after that
// only turn activity does, so the tail probe measures audio silence.
func (w *receiveWait) onFrame(t *Transport, etype string, now time.Time) {
	w.sawInbound = true
	if etype == "" {
		etype = evUnknown
	}
	if w.framesByType == nil {
		w.framesByType = make(map[string]int, 4)
	}
	w.framesByType[etype]++
	toolTurn := t.toolTurnOpen
	if t.awaitingUserTurn && !toolTurn && !isTurnActivity(etype) {
		return
	}
	w.idleBudget = w.timeout
	if toolTurn {
		w.idleBudget = w.toolBudget
	}
	w.idleArmedAt = now
	select {
	case w.rearm <- struct{}{}:
	default:
	}
}

// deliverLocked hands chunk to the first waiting receiver, else queues it.
func (t *Transport) deliverLocked(chunk voice.AudioChunk) {
	if len(t.waiters) > 0 {
		t.handOffLocked(chunk)
		return
	}
	t.queue = append(t.queue, chunk)
}

// handOffLocked gives chunk to the first waiting receiver.
func (t *Transport) handOffLocked(chunk voice.AudioChunk) {
	w := t.waiters[0]
	t.waiters = t.waiters[1:]
	w.done = true
	w.ch <- chunk
}

// drainWaitersLocked releases every waiting receiver with an empty chunk.
func (t *Transport) drainWaitersLocked() {
	for len(t.waiters) > 0 {
		t.handOffLocked(voice.AudioChunk{})
	}
}

func (t *Transport) removeWaiterLocked(w *receiveWait) {
	for i, x := range t.waiters {
		if x == w {
			t.waiters = append(t.waiters[:i], t.waiters[i+1:]...)
			return
		}
	}
}

// ReceiveAudio implements voice.Transport. It returns the next agent chunk,
// an empty chunk when the turn ended without audio (a client tool call, the
// session closing), or a *ReceiveTimeoutError.
//
// timeout is an idle deadline: until the agent speaks, every inbound frame
// (keepalive pings included) re-arms it, so a slow but live agent is not
// cut off. An absolute ceiling of max(timeout, 45s) that nothing re-arms
// bounds an agent that pings but never speaks.
func (t *Transport) ReceiveAudio(ctx context.Context, timeout time.Duration) (voice.AudioChunk, error) {
	t.mu.Lock()
	if !t.activeLocked() {
		t.mu.Unlock()
		return voice.AudioChunk{}, ErrNotConnected
	}
	if len(t.queue) > 0 {
		c := t.queue[0]
		t.queue[0] = voice.AudioChunk{}
		t.queue = t.queue[1:]
		t.mu.Unlock()
		return c, nil
	}
	now := time.Now()
	w := &receiveWait{
		ch:         make(chan voice.AudioChunk, 1),
		rearm:      make(chan struct{}, 1),
		timeout:    timeout,
		toolBudget: max(timeout, t.responseTimeout()),
		started:    now,
	}
	w.idleArmedAt = now
	w.idleBudget = timeout
	if t.toolTurnOpen {
		w.idleBudget = w.toolBudget
	}
	ceiling := max(timeout, t.ceilingFloor)
	floor, firstBudget := t.ceilingFloor, w.idleBudget
	t.waiters = append(t.waiters, w)
	t.mu.Unlock()

	span := trace.SpanFromContext(ctx)
	idle := time.NewTimer(firstBudget)
	defer idle.Stop()
	hard := time.NewTimer(ceiling)
	defer hard.Stop()
	for {
		select {
		case c := <-w.ch:
			return c, nil
		case <-w.rearm:
			t.mu.Lock()
			due := w.idleArmedAt.Add(w.idleBudget)
			t.mu.Unlock()
			idle.Reset(time.Until(due))
		case <-idle.C:
			t.mu.Lock()
			if w.done {
				t.mu.Unlock()
				return <-w.ch, nil
			}
			if due := w.idleArmedAt.Add(w.idleBudget); time.Now().Before(due) {
				t.mu.Unlock()
				idle.Reset(time.Until(due))
				continue
			}
			return voice.AudioChunk{}, t.endWaitLocked(w, span, false, ceiling, floor)
		case <-hard.C:
			t.mu.Lock()
			if w.done {
				t.mu.Unlock()
				return <-w.ch, nil
			}
			// Nothing received means the socket was silent throughout: the
			// idle diagnosis is the true one, however the two deadlines
			// happened to be ordered.
			return voice.AudioChunk{}, t.endWaitLocked(w, span, w.sawInbound, ceiling, floor)
		case <-ctx.Done():
			t.mu.Lock()
			if w.done {
				t.mu.Unlock()
				return <-w.ch, nil
			}
			t.removeWaiterLocked(w)
			t.mu.Unlock()
			return voice.AudioChunk{}, ctx.Err()
		}
	}
}

// endWaitLocked unparks w after a deadline, records the wait diagnosis on
// span and in the log, and returns the deadline's error. It unlocks t.mu.
func (t *Transport) endWaitLocked(w *receiveWait, span trace.Span, ceilingEnd bool, ceiling, floor time.Duration) error {
	t.removeWaiterLocked(w)
	now := time.Now()
	end, due := "idle", w.idleArmedAt.Add(w.idleBudget)
	if ceilingEnd {
		end, due = "ceiling", w.started.Add(ceiling)
	}
	waited := now.Sub(w.started)
	late := max(0, now.Sub(due))
	frames := make(map[string]int, len(w.framesByType))
	for k, v := range w.framesByType {
		frames[k] = v
	}
	afterAgentAudio := t.awaitingUserTurn
	idleBudget := w.idleBudget
	t.mu.Unlock()

	framesJSON, _ := json.Marshal(frames)
	voice.SetSpanAttributes(span,
		attribute.String("voice.elevenlabs.receive_wait_end", end),
		attribute.Int64("voice.elevenlabs.receive_wait_ms", waited.Milliseconds()),
		attribute.Int64("voice.elevenlabs.receive_wait_late_ms", late.Milliseconds()),
		attribute.String("voice.elevenlabs.receive_wait_frames", string(framesJSON)))
	details := []any{"end", end, "timeoutS", w.timeout.Seconds(), "waitedMs", waited.Milliseconds(),
		"lateMs", late.Milliseconds(), "afterAgentAudio", afterAgentAudio, "framesByType", frames}
	switch {
	case ceilingEnd:
		t.o.Logger.Warn("receiveAudio ended on the absolute ceiling; framesByType shows what kept the wait open", details...)
	case late > lateTimerWarn:
		t.o.Logger.Warn("receiveAudio deadline fired late; the host was stalled", details...)
	default:
		t.o.Logger.Debug("receiveAudio ended on its idle deadline", details...)
	}
	if ceilingEnd {
		return ceilingTimeoutError(w.timeout, ceiling, floor)
	}
	return idleTimeoutError(idleBudget)
}

// ReconcilePendingAudio implements voice.PendingAudioReconciler: it drains
// every queued agent chunk, merged. The runtime calls it when a new user
// turn commits, when the queue can only hold the previous agent turn's
// leftover; returning it lets the runtime attribute it to that turn instead
// of the next receive surfacing it as a fake start of the next one.
func (t *Transport) ReconcilePendingAudio() (voice.AudioChunk, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.queue) == 0 {
		return voice.AudioChunk{}, false
	}
	total := 0
	for _, c := range t.queue {
		total += len(c.Data)
	}
	data := make([]byte, 0, total)
	for i, c := range t.queue {
		data = append(data, c.Data...)
		t.queue[i] = voice.AudioChunk{}
	}
	t.queue = t.queue[:0]
	return voice.AudioChunk{Data: data}, true
}
