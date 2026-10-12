package effects

import "errors"

// Custom wraps fn, a transform from PCM16 bytes to PCM16 bytes, as an
// Effect. fn receives the input audio and must not keep or modify it.
func Custom(fn func(pcm []byte) []byte) (Effect, error) {
	if fn == nil {
		return nil, errors.New("effects: Custom requires a function that takes and returns audio bytes")
	}
	return func(dst, src []byte) []byte {
		return append(dst, fn(src)...)
	}, nil
}
