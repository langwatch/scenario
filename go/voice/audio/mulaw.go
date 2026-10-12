package audio

import (
	"encoding/binary"
	"sync"
)

// G.711 µ-law constants (ITU-T reference encoder).
const (
	mulawBias = 0x84  // added to the magnitude so zero maps to a non-zero code
	mulawClip = 32635 // magnitudes above this saturate to the top segment
)

// mulawTables holds both lookup tables. They are built together on first
// use: 256 decode entries and 64 Ki encode entries (one per int16 value),
// about 64.5 KiB in total, allocated only by programs that touch µ-law.
type mulawTables struct {
	decode [256]int16
	encode [1 << 16]uint8
}

var (
	mulawOnce sync.Once
	mulawLUTs *mulawTables
)

// mulawLUT returns the tables, building them on first use. A plain
// sync.Once (rather than sync.OnceValue) keeps package initialisation free
// of allocations.
func mulawLUT() *mulawTables {
	mulawOnce.Do(func() {
		t := new(mulawTables)
		for b := range 256 {
			t.decode[b] = mulawDecodeSlow(uint8(b))
		}
		for v := range 1 << 16 {
			t.encode[v] = mulawEncodeSlow(int16(uint16(v)))
		}
		mulawLUTs = t
	})
	return mulawLUTs
}

// mulawEncodeSlow is the ITU-T G.711 reference encode formula, identical to
// Python's audioop.lin2ulaw and the JavaScript SDK. Used to build the table.
func mulawEncodeSlow(pcm int16) uint8 {
	sample := int32(pcm)
	sign := int32(0)
	if sample < 0 {
		sample = -sample
		sign = 0x80
	}
	if sample > mulawClip {
		sample = mulawClip
	}
	sample += mulawBias
	segment := int32(0)
	for s := sample >> 7; s >= 2; s >>= 1 {
		segment++
	}
	if segment > 7 {
		segment = 7
	}
	quant := (sample >> (segment + 3)) & 0x0f
	return ^uint8(sign | segment<<4 | quant)
}

// mulawDecodeSlow is the ITU-T G.711 reference decode formula.
func mulawDecodeSlow(b uint8) int16 {
	inv := ^b
	segment := int32(inv>>4) & 0x07
	quant := int32(inv) & 0x0f
	magnitude := ((quant<<3)|mulawBias)<<segment - mulawBias
	if inv&0x80 != 0 {
		return int16(-magnitude)
	}
	return int16(magnitude)
}

// MulawEncode encodes one PCM16 sample as a G.711 µ-law byte.
func MulawEncode(s int16) uint8 { return mulawLUT().encode[uint16(s)] }

// MulawDecode decodes one G.711 µ-law byte to a PCM16 sample.
func MulawDecode(b uint8) int16 { return mulawLUT().decode[b] }

// AppendMulaw encodes little-endian PCM16 samples as µ-law (same sample
// rate) and appends them to dst. A trailing odd byte is ignored.
func AppendMulaw(dst, pcm []byte) []byte {
	enc := &mulawLUT().encode
	n := len(pcm) / 2
	off := len(dst)
	dst = Extend(dst, n)
	out := dst[off:]
	for i := range out {
		out[i] = enc[binary.LittleEndian.Uint16(pcm[2*i:])]
	}
	return dst
}

// AppendMulawDecoded decodes µ-law bytes to little-endian PCM16 samples
// (same sample rate) and appends them to dst.
func AppendMulawDecoded(dst, mulaw []byte) []byte {
	dec := &mulawLUT().decode
	off := len(dst)
	dst = Extend(dst, 2*len(mulaw))
	out := dst[off:]
	for i, b := range mulaw {
		binary.LittleEndian.PutUint16(out[2*i:], uint16(dec[b]))
	}
	return dst
}

// Twilio-style telephony audio: µ-law, 8 kHz, mono.
const TelephonySampleRate = 8000

// AppendMulaw8k converts canonical PCM16 24 kHz to µ-law 8 kHz and appends it
// to dst, fusing the resample and the encode so no intermediate buffer is
// needed. The output equals [Resample] to 8 kHz followed by [AppendMulaw].
func AppendMulaw8k(dst, pcm24k []byte) []byte {
	if len(pcm24k) < 2 {
		return dst
	}
	enc := &mulawLUT().encode
	// 24 kHz to 8 kHz is an integral ratio, so the linear interpolator always
	// lands exactly on an input sample: it is pure decimation by three.
	in := len(pcm24k) / 2
	out := resampledLen(in, SampleRate, TelephonySampleRate)
	off := len(dst)
	dst = Extend(dst, out)
	o := dst[off:]
	for i := range o {
		o[i] = enc[binary.LittleEndian.Uint16(pcm24k[6*i:])]
	}
	return dst
}

// AppendPCM24kFromMulaw8k converts µ-law 8 kHz to canonical PCM16 24 kHz and
// appends it to dst. The output equals [AppendMulawDecoded] followed by
// [Resample] to 24 kHz, without the intermediate buffer.
func AppendPCM24kFromMulaw8k(dst, mulaw8k []byte) []byte {
	if len(mulaw8k) == 0 {
		return dst
	}
	return appendInterpolatedMulaw(dst, mulaw8k, TelephonySampleRate, SampleRate)
}
