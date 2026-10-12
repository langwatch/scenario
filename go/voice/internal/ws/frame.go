package ws

import (
	"bufio"
	"encoding/binary"
)

// MessageType is the type of a data message. The values match
// github.com/coder/websocket's, so the two convert by value.
type MessageType int

const (
	// MessageText is a UTF-8 text message.
	MessageText MessageType = 1
	// MessageBinary is a binary message.
	MessageBinary MessageType = 2
)

type opcode byte

const (
	opContinuation opcode = 0x0
	opText         opcode = 0x1
	opBinary       opcode = 0x2
	opClose        opcode = 0x8
	opPing         opcode = 0x9
	opPong         opcode = 0xA
)

const (
	// maxControlPayload is the largest control frame payload (RFC 6455 5.5).
	maxControlPayload = 125
	// maxHeaderSize is the largest frame header: 2 bytes, an 8-byte
	// extended length and a 4-byte mask key.
	maxHeaderSize = 14
)

// header is one frame header.
type header struct {
	fin    bool
	rsv    byte // the three reserved bits, in place (0x70)
	op     opcode
	masked bool
	// key is the mask key in wire order, read as a little-endian uint32 (the
	// form mask takes).
	key    uint32
	length int64
}

// readHeader reads one frame header. Peek returns a view of br's buffer,
// so nothing is copied or allocated.
func readHeader(br *bufio.Reader) (header, error) {
	b, err := br.Peek(2)
	if err != nil {
		return header{}, err
	}
	h := header{
		fin:    b[0]&0x80 != 0,
		rsv:    b[0] & 0x70,
		op:     opcode(b[0] & 0x0F),
		masked: b[1]&0x80 != 0,
	}
	n := 2
	length := int64(b[1] & 0x7F)
	switch length {
	case 126:
		n += 2
	case 127:
		n += 8
	}
	if h.masked {
		n += 4
	}
	if b, err = br.Peek(n); err != nil {
		return header{}, err
	}
	p := b[2:]
	switch length {
	case 126:
		length = int64(binary.BigEndian.Uint16(p))
		p = p[2:]
	case 127:
		u := binary.BigEndian.Uint64(p)
		if u>>63 != 0 {
			// The most significant bit must be 0 (RFC 6455 5.2).
			_, _ = br.Discard(n)
			return header{}, protocolError("frame length has the most significant bit set")
		}
		length = int64(u)
		p = p[8:]
	}
	h.length = length
	if h.masked {
		h.key = binary.LittleEndian.Uint32(p)
	}
	_, _ = br.Discard(n)
	return h, nil
}

// appendHeader appends a frame header for a payload of length bytes.
// masked frames carry key (wire order, as a little-endian uint32).
func appendHeader(dst []byte, fin bool, op opcode, length int, masked bool, key uint32) []byte {
	b0 := byte(op)
	if fin {
		b0 |= 0x80
	}
	var mbit byte
	if masked {
		mbit = 0x80
	}
	switch {
	case length <= 125:
		dst = append(dst, b0, mbit|byte(length))
	case length <= 0xFFFF:
		dst = append(dst, b0, mbit|126)
		dst = binary.BigEndian.AppendUint16(dst, uint16(length))
	default:
		dst = append(dst, b0, mbit|127)
		dst = binary.BigEndian.AppendUint64(dst, uint64(length))
	}
	if masked {
		dst = binary.LittleEndian.AppendUint32(dst, key)
	}
	return dst
}
