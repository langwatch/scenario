package scenario

import (
	"sync"
)

// channelEventBus is a channel-based EventBus implementation.
type channelEventBus struct {
	mu          sync.RWMutex
	subscribers map[<-chan ScenarioEvent]chan ScenarioEvent
	closed      bool
}

// NewEventBus creates a new channel-based EventBus.
func NewEventBus() EventBus {
	return &channelEventBus{
		subscribers: make(map[<-chan ScenarioEvent]chan ScenarioEvent),
	}
}

func (b *channelEventBus) Publish(event ScenarioEvent) {
	b.mu.RLock()
	defer b.mu.RUnlock()

	if b.closed {
		return
	}

	for _, ch := range b.subscribers {
		// Non-blocking send; drop if subscriber is slow
		select {
		case ch <- event:
		default:
		}
	}
}

func (b *channelEventBus) Subscribe() <-chan ScenarioEvent {
	b.mu.Lock()
	defer b.mu.Unlock()

	ch := make(chan ScenarioEvent, 64)
	b.subscribers[ch] = ch
	return ch
}

func (b *channelEventBus) Unsubscribe(ch <-chan ScenarioEvent) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if writeCh, ok := b.subscribers[ch]; ok {
		close(writeCh)
		delete(b.subscribers, ch)
	}
}

func (b *channelEventBus) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.closed {
		return
	}
	b.closed = true

	for readCh, writeCh := range b.subscribers {
		close(writeCh)
		delete(b.subscribers, readCh)
	}
}

func (b *channelEventBus) Drain() {
	// For the channel-based implementation, Close() is sufficient.
	// All buffered events will be available in subscriber channels.
	b.Close()
}
