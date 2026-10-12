// Package effects degrades and colours synthesized user speech so a voice
// agent is tested against realistic callers: background noise, phone-line
// band limiting, packet loss, echo, volume and speed changes, and custom
// transforms.
//
// Every effect works on canonical PCM16 (24 kHz, mono) and is applied after
// the TTS cache read, never baked into cached audio. Numerics follow the
// JavaScript SDK (javascript/src/voice/effects), including its single
// precision intermediate buffers and its rounding, so the same input gives
// the same output in both SDKs.
//
// Accents are not an effect: pick an accented TTS voice instead
// (for example "elevenlabs/raj_indian_english").
package effects

import "sync"

// Effect transforms canonical PCM16 audio. It appends its output for src to
// dst and returns the extended slice, and never modifies src. Passing a
// reused dst[:0] makes repeated application allocation-free.
//
// Output length equals input length except for the speed effects, which
// time-stretch. A trailing odd byte in src is dropped.
type Effect func(dst, src []byte) []byte

// Apply runs src through effects in order and returns a new buffer holding
// the result. With no effects it returns a copy of src.
func Apply(src []byte, effects ...Effect) []byte {
	return Chain(effects...)(nil, src)
}

// Chain composes effects into one, applied left to right. Intermediate
// results live in pooled scratch buffers, so only dst is written to.
func Chain(effects ...Effect) Effect {
	effects = append([]Effect(nil), effects...)
	return func(dst, src []byte) []byte {
		switch len(effects) {
		case 0:
			return append(dst, src...)
		case 1:
			return effects[0](dst, src)
		}
		a, b := getScratch(), getScratch()
		defer putScratch(a)
		defer putScratch(b)
		cur := src
		for _, e := range effects[:len(effects)-1] {
			*a = e((*a)[:0], cur)
			cur = *a
			a, b = b, a
		}
		return effects[len(effects)-1](dst, cur)
	}
}

// Must returns e, panicking if err is non-nil. It suits effect lists built
// from constant, known-good arguments:
//
//	fx := effects.Chain(effects.Must(effects.LowVolume(0.5)), effects.PhoneQuality())
func Must(e Effect, err error) Effect {
	if err != nil {
		panic(err)
	}
	return e
}

var scratchPool = sync.Pool{New: func() any { return new([]byte) }}

func getScratch() *[]byte { return scratchPool.Get().(*[]byte) }

func putScratch(b *[]byte) {
	// Keep the pool from pinning one-off huge buffers (about 20 s of audio).
	if cap(*b) > 1<<20 {
		return
	}
	scratchPool.Put(b)
}
