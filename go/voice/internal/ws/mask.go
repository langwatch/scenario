package ws

import (
	"encoding/binary"
	"math/bits"
)

// mask XORs b in place with the mask key, starting at key byte pos (the
// payload offset of b[0], mod 4), and returns the key position after b.
// key holds the four key bytes in wire order as a little-endian uint32.
// Masking and unmasking are the same operation.
func mask(b []byte, key uint32, pos int) int {
	next := (pos + len(b)) & 3
	// Rotate so the low byte is the key byte for b[0].
	k := bits.RotateLeft32(key, -8*(pos&3))
	if len(b) >= 8 {
		k64 := uint64(k)<<32 | uint64(k)
		for len(b) >= 32 {
			binary.LittleEndian.PutUint64(b, binary.LittleEndian.Uint64(b)^k64)
			binary.LittleEndian.PutUint64(b[8:], binary.LittleEndian.Uint64(b[8:])^k64)
			binary.LittleEndian.PutUint64(b[16:], binary.LittleEndian.Uint64(b[16:])^k64)
			binary.LittleEndian.PutUint64(b[24:], binary.LittleEndian.Uint64(b[24:])^k64)
			b = b[32:]
		}
		for len(b) >= 8 {
			binary.LittleEndian.PutUint64(b, binary.LittleEndian.Uint64(b)^k64)
			b = b[8:]
		}
	}
	for i := range b {
		b[i] ^= byte(k)
		k = bits.RotateLeft32(k, -8)
	}
	return next
}

// maskCopy writes src XOR the mask key into dst (len(dst) >= len(src)),
// starting at key byte pos, and returns the key position after src. It
// masks while copying, so the caller's payload is never modified.
func maskCopy(dst, src []byte, key uint32, pos int) int {
	next := (pos + len(src)) & 3
	k := bits.RotateLeft32(key, -8*(pos&3))
	dst = dst[:len(src)]
	if len(src) >= 8 {
		k64 := uint64(k)<<32 | uint64(k)
		for len(src) >= 8 {
			binary.LittleEndian.PutUint64(dst, binary.LittleEndian.Uint64(src)^k64)
			src, dst = src[8:], dst[8:]
		}
	}
	for i := range src {
		dst[i] = src[i] ^ byte(k)
		k = bits.RotateLeft32(k, -8)
	}
	return next
}
