package ws

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"math/rand/v2"
	"testing"
)

func TestHeaderRoundTrip(t *testing.T) {
	for _, length := range []int{0, 1, 125, 126, 127, 0xFFFF, 0x10000, 1 << 20} {
		for _, masked := range []bool{false, true} {
			for _, fin := range []bool{false, true} {
				key := uint32(0xA1B2C3D4)
				b := appendHeader(nil, fin, opBinary, length, masked, key)
				h, err := readHeader(bufio.NewReader(bytes.NewReader(b)))
				if err != nil {
					t.Fatalf("len %d: %v", length, err)
				}
				if h.fin != fin || h.op != opBinary || h.masked != masked || h.length != int64(length) || h.rsv != 0 {
					t.Fatalf("len %d masked %v fin %v: got %+v", length, masked, fin, h)
				}
				if masked && h.key != key {
					t.Fatalf("key %x, want %x", h.key, key)
				}
			}
		}
	}
}

func TestHeaderUsesTheShortestLengthEncoding(t *testing.T) {
	for _, c := range []struct{ length, size int }{{125, 2}, {126, 4}, {0xFFFF, 4}, {0x10000, 10}} {
		if got := len(appendHeader(nil, true, opText, c.length, false, 0)); got != c.size {
			t.Fatalf("length %d: header %d bytes, want %d", c.length, got, c.size)
		}
	}
}

func TestHeaderRejectsA64BitLengthWithTheTopBitSet(t *testing.T) {
	b := []byte{0x82, 127}
	b = binary.BigEndian.AppendUint64(b, 1<<63)
	_, err := readHeader(bufio.NewReader(bytes.NewReader(b)))
	var pe *ProtocolError
	if !errors.As(err, &pe) || pe.Code != StatusProtocolError {
		t.Fatalf("err = %v, want a protocol error", err)
	}
}

func TestHeaderReadsReservedBits(t *testing.T) {
	h, err := readHeader(bufio.NewReader(bytes.NewReader([]byte{0x80 | 0x40 | byte(opText), 0})))
	if err != nil || h.rsv != 0x40 {
		t.Fatalf("h = %+v, err = %v", h, err)
	}
}

// naiveMask is RFC 6455 5.3 verbatim.
func naiveMask(b []byte, key [4]byte, pos int) {
	for i := range b {
		b[i] ^= key[(pos+i)%4]
	}
}

func TestMaskMatchesTheRFCDefinition(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	for n := range 300 {
		for pos := range 4 {
			var key [4]byte
			binary.LittleEndian.PutUint32(key[:], r.Uint32())
			src := make([]byte, n)
			for i := range src {
				src[i] = byte(r.Uint32())
			}
			want := bytes.Clone(src)
			naiveMask(want, key, pos)

			got := bytes.Clone(src)
			if next := mask(got, binary.LittleEndian.Uint32(key[:]), pos); next != (pos+n)%4 {
				t.Fatalf("n %d pos %d: next %d", n, pos, next)
			}
			if !bytes.Equal(got, want) {
				t.Fatalf("mask n %d pos %d differs", n, pos)
			}

			dst := make([]byte, n)
			if next := maskCopy(dst, src, binary.LittleEndian.Uint32(key[:]), pos); next != (pos+n)%4 {
				t.Fatalf("maskCopy n %d pos %d: next %d", n, pos, next)
			}
			if !bytes.Equal(dst, want) {
				t.Fatalf("maskCopy n %d pos %d differs", n, pos)
			}
		}
	}
}

func TestMaskInPiecesEqualsMaskInOne(t *testing.T) {
	key := uint32(0x01020304)
	whole := bytes.Repeat([]byte("abcdefghij"), 50)
	pieces := bytes.Clone(whole)
	mask(whole, key, 0)
	rest, pos := pieces, 0
	for _, cut := range []int{3, 7, 1, 64, 100} {
		pos = mask(rest[:cut], key, pos)
		rest = rest[cut:]
	}
	mask(rest, key, pos)
	if !bytes.Equal(pieces, whole) {
		t.Fatal("masking in pieces differs from masking at once")
	}
}

func TestParseClose(t *testing.T) {
	enc := func(code int, reason string) []byte {
		return append(binary.BigEndian.AppendUint16(nil, uint16(code)), reason...)
	}
	valid := []int{1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 3000, 3999, 4000, 4999}
	for _, code := range valid {
		ce, err := parseClose(enc(code, "bye"))
		if err != nil || ce.Code != StatusCode(code) || ce.Reason != "bye" {
			t.Fatalf("code %d: %+v, %v", code, ce, err)
		}
	}
	invalid := []int{0, 999, 1004, 1005, 1006, 1015, 1016, 1100, 2000, 2999, 5000, 65535}
	for _, code := range invalid {
		if _, err := parseClose(enc(code, "")); err == nil {
			t.Fatalf("code %d accepted", code)
		}
	}
	if ce, err := parseClose(nil); err != nil || ce.Code != StatusNoStatusRcvd {
		t.Fatalf("empty: %+v, %v", ce, err)
	}
	if _, err := parseClose([]byte{0x03}); err == nil {
		t.Fatal("one-byte payload accepted")
	}
	_, err := parseClose(enc(1000, "\xff\xfe"))
	var pe *ProtocolError
	if !errors.As(err, &pe) || pe.Code != StatusInvalidFramePayloadData {
		t.Fatalf("invalid UTF-8 reason: %v", err)
	}
}

func TestAppendClose(t *testing.T) {
	if p := appendClose(nil, StatusNoStatusRcvd, "x"); len(p) != 0 {
		t.Fatalf("1005 payload %q, want empty", p)
	}
	if p := appendClose(nil, StatusAbnormalClosure, "x"); binary.BigEndian.Uint16(p) != uint16(StatusInternalError) {
		t.Fatalf("1006 is not sendable; got %v", p)
	}
	long := string(bytes.Repeat([]byte("é"), 100)) // 200 bytes
	p := appendClose(nil, StatusNormalClosure, long)
	if len(p) > maxControlPayload {
		t.Fatalf("payload %d bytes", len(p))
	}
	if _, err := parseClose(p); err != nil {
		t.Fatalf("truncated reason is not valid: %v", err)
	}
}

func TestAcceptKey(t *testing.T) {
	// RFC 6455 1.3.
	if got := acceptKey("dGhlIHNhbXBsZSBub25jZQ=="); got != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Fatalf("acceptKey = %q", got)
	}
}
