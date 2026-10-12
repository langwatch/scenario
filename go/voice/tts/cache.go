package tts

import (
	"container/list"
	"crypto/sha256"
	"sync"
	"unsafe"
)

// DefaultCacheEntries bounds the synthesis cache. A 5-minute clip is about
// 14 MB, so 64 entries cap it near 900 MB even for long utterances.
const DefaultCacheEntries = 64

// cacheKey is (sha256(text), voice): deterministic for identical text
// without keeping the raw text in the cache.
type cacheKey struct {
	text  [sha256.Size]byte
	voice string
}

func keyFor(text, voice string) cacheKey {
	// Hash the string's bytes in place: Sum256 only reads its input, and a
	// []byte(text) conversion would allocate for every lookup.
	return cacheKey{text: sha256.Sum256(unsafe.Slice(unsafe.StringData(text), len(text))), voice: voice}
}

type cacheEntry struct {
	key cacheKey
	pcm []byte
}

// lru is a bounded least-recently-used map from cacheKey to PCM. It is safe
// for concurrent use.
type lru struct {
	mu    sync.Mutex
	max   int
	order *list.List // front = most recent; values are *cacheEntry
	items map[cacheKey]*list.Element
}

func newLRU(max int) *lru {
	return &lru{max: max, order: list.New(), items: map[cacheKey]*list.Element{}}
}

func (c *lru) get(k cacheKey) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.items[k]
	if !ok {
		return nil, false
	}
	c.order.MoveToFront(e)
	return e.Value.(*cacheEntry).pcm, true
}

func (c *lru) put(k cacheKey, pcm []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.items[k]; ok {
		e.Value.(*cacheEntry).pcm = pcm
		c.order.MoveToFront(e)
		return
	}
	c.items[k] = c.order.PushFront(&cacheEntry{key: k, pcm: pcm})
	for c.order.Len() > c.max {
		oldest := c.order.Back()
		c.order.Remove(oldest)
		delete(c.items, oldest.Value.(*cacheEntry).key)
	}
}

func (c *lru) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.order.Init()
	clear(c.items)
}

func (c *lru) len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.order.Len()
}
