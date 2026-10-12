package mediastream

import (
	"encoding/base64"
	"unicode/utf8"
)

// AppendMediaFrame appends an outbound media frame carrying the µ-law
// payload:
//
//	{"event":"media","streamSid":"…","media":{"payload":"<base64>"}}
//
// Field order and escaping match the JavaScript SDK's JSON.stringify output.
func AppendMediaFrame(dst []byte, streamSID string, mulaw []byte) []byte {
	dst = append(dst, `{"event":"media","streamSid":`...)
	dst = appendJSONString(dst, streamSID)
	dst = append(dst, `,"media":{"payload":"`...)
	dst = base64.StdEncoding.AppendEncode(dst, mulaw)
	return append(dst, `"}}`...)
}

// AppendClearFrame appends a clear frame, which tells the receiver to drop
// its buffered outbound audio (interruption).
func AppendClearFrame(dst []byte, streamSID string) []byte {
	dst = append(dst, `{"event":"clear","streamSid":`...)
	dst = appendJSONString(dst, streamSID)
	return append(dst, '}')
}

// AppendMarkFrame appends a mark frame: a named marker that cooperating
// receivers echo back once the audio before it has played out.
func AppendMarkFrame(dst []byte, streamSID, name string) []byte {
	dst = append(dst, `{"event":"mark","streamSid":`...)
	dst = appendJSONString(dst, streamSID)
	dst = append(dst, `,"mark":{"name":`...)
	dst = appendJSONString(dst, name)
	return append(dst, `}}`...)
}

// AppendStopFrame appends a stop frame.
func AppendStopFrame(dst []byte, streamSID string) []byte {
	dst = append(dst, `{"event":"stop","streamSid":`...)
	dst = appendJSONString(dst, streamSID)
	return append(dst, '}')
}

const hexDigits = "0123456789abcdef"

// appendJSONString appends s as a JSON string literal the way JSON.stringify
// writes it: quotes, backslashes and control characters are escaped, every
// other character is written as is. Invalid UTF-8 becomes U+FFFD.
func appendJSONString(dst []byte, s string) []byte {
	dst = append(dst, '"')
	start := 0
	for i := 0; i < len(s); {
		c := s[i]
		if c >= utf8.RuneSelf {
			r, size := utf8.DecodeRuneInString(s[i:])
			if r == utf8.RuneError && size == 1 {
				dst = append(dst, s[start:i]...)
				dst = append(dst, "�"...)
				i++
				start = i
				continue
			}
			i += size
			continue
		}
		if c >= 0x20 && c != '"' && c != '\\' {
			i++
			continue
		}
		dst = append(dst, s[start:i]...)
		switch c {
		case '"', '\\':
			dst = append(dst, '\\', c)
		case '\b':
			dst = append(dst, '\\', 'b')
		case '\f':
			dst = append(dst, '\\', 'f')
		case '\n':
			dst = append(dst, '\\', 'n')
		case '\r':
			dst = append(dst, '\\', 'r')
		case '\t':
			dst = append(dst, '\\', 't')
		default:
			dst = append(dst, '\\', 'u', '0', '0', hexDigits[c>>4], hexDigits[c&0xf])
		}
		i++
		start = i
	}
	dst = append(dst, s[start:]...)
	return append(dst, '"')
}
