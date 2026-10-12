// Package audio holds the pure audio primitives the voice subsystem is built
// on: the canonical [Chunk] (PCM16, 24 kHz, mono), PCM16 sample access, WAV
// encoding and parsing, G.711 µ-law, linear resampling, RMS energy and a small
// radix-2 FFT.
//
// Everything here is allocation-conscious. Conversions use append-style
// signatures (dst = AppendX(dst[:0], src)) so a caller that reuses its buffer
// converts a 20 ms frame without allocating, and lookup tables are built on
// first use rather than at program start.
//
// Numerics match the JavaScript SDK (javascript/src/voice), including its
// rounding (ties toward +Inf), so recordings and fixtures agree across SDKs.
package audio
