package voice

import "sync"

// SpeakingEvent is set when the agent's first audio of the current turn
// arrived. Interruption waits on it so a barge-in overlaps real agent
// speech. It is re-armed at the start of every turn.
type SpeakingEvent struct {
	mu  sync.Mutex
	ch  chan struct{}
	set bool
}

func (e *SpeakingEvent) chanLocked() chan struct{} {
	if e.ch == nil {
		e.ch = make(chan struct{})
	}
	return e.ch
}

// Set marks the agent as speaking and wakes every waiter.
func (e *SpeakingEvent) Set() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.set {
		return
	}
	e.set = true
	close(e.chanLocked())
}

// IsSet reports whether the agent started speaking this turn.
func (e *SpeakingEvent) IsSet() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.set
}

// Wait returns a channel closed once the event is set.
func (e *SpeakingEvent) Wait() <-chan struct{} {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.chanLocked()
}

// Clear re-arms the event for the next turn.
func (e *SpeakingEvent) Clear() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.set {
		e.set = false
		e.ch = nil
	}
}
