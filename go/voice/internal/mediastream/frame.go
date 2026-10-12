// Package mediastream is the Twilio Media Streams wire protocol shared by the
// telephony adapters: JSON frame parsing and encoding, a paced µ-law frame
// sender, an inbound chunk queue and a WebSocket connection wrapper.
//
// Twilio Media Streams always carry µ-law 8 kHz mono in 20 ms frames, base64
// inside JSON text frames. The media frame paths (parse and encode) are
// hand-rolled and reuse their buffers, so steady-state frames do not
// allocate; control frames (start, dtmf, mark) go through encoding/json.
package mediastream

import (
	"encoding/base64"
	"encoding/json"
	"unicode/utf16"
	"unicode/utf8"
)

// Wire constants of Twilio Media Streams.
const (
	// SampleRate is the wire sample rate: µ-law 8 kHz mono.
	SampleRate = 8000
	// FrameMs is the length of one media frame.
	FrameMs = 20
	// FrameBytes is one 20 ms frame of µ-law 8 kHz: 160 bytes.
	FrameBytes = SampleRate * FrameMs / 1000
	// BatchBytes is how much inbound µ-law (100 ms) is coalesced before it is
	// decoded into one canonical chunk.
	BatchBytes = 800
)

// Event is a Media Streams event type.
type Event uint8

// The known Media Streams events. Unknown events never reach callers.
const (
	EventUnknown Event = iota
	EventConnected
	EventStart
	EventMedia
	EventStop
	EventDTMF
	EventMark
)

func eventOf(name []byte) Event {
	switch string(name) {
	case "connected":
		return EventConnected
	case "start":
		return EventStart
	case "media":
		return EventMedia
	case "stop":
		return EventStop
	case "dtmf":
		return EventDTMF
	case "mark":
		return EventMark
	}
	return EventUnknown
}

// Frame is one parsed inbound frame. Its byte-slice fields alias the
// parser's buffers or the parsed input and are valid until the next Parse.
type Frame struct {
	Event Event
	// StreamSID is the top-level streamSid, else start.streamSid.
	StreamSID []byte
	// CallSID is start.callSid (start frames only).
	CallSID string
	// Payload is the decoded µ-law of a media frame.
	Payload []byte
	// DTMFDigit is dtmf.digit of a dtmf frame.
	DTMFDigit string
	// MarkName is mark.name of a mark frame.
	MarkName string
	// CustomParameters are start.customParameters (the <Parameter> children
	// of <Stream>); string values only.
	CustomParameters map[string]string
}

// Parser parses inbound frames, reusing its buffers across calls. It is not
// safe for concurrent use.
type Parser struct {
	payload []byte
	scratch []byte
}

// Parse parses one JSON text frame. It reports false for malformed JSON,
// unknown events and events missing a required field, which callers ignore:
// Twilio adds event types over time and an unknown shape must never break the
// receive loop.
func (p *Parser) Parse(data []byte) (Frame, bool) {
	var (
		f                    Frame
		s                    = scanner{b: data}
		haveEvent, payloadOK bool
		start, dtmf, mark    []byte
		eventName, streamSID []byte
		streamIsStr          bool
	)
	if !s.consume('{') {
		return Frame{}, false
	}
	if !s.consume('}') {
		for {
			key, ok := p.str(&s)
			if !ok || !s.consume(':') {
				return Frame{}, false
			}
			switch string(key) {
			case "event":
				v, isStr, ok := p.value(&s)
				if !ok {
					return Frame{}, false
				}
				eventName, haveEvent = v, isStr
			case "streamSid":
				v, isStr, ok := p.value(&s)
				if !ok {
					return Frame{}, false
				}
				streamSID, streamIsStr = v, isStr
			case "media":
				ok, found := p.media(&s)
				if !ok {
					return Frame{}, false
				}
				payloadOK = found
			case "start", "dtmf", "mark":
				raw, ok := s.rawValue()
				if !ok {
					return Frame{}, false
				}
				switch key[0] {
				case 's':
					start = raw
				case 'd':
					dtmf = raw
				default:
					mark = raw
				}
			default:
				if !s.skipValue() {
					return Frame{}, false
				}
			}
			if s.consume(',') {
				continue
			}
			if s.consume('}') {
				break
			}
			return Frame{}, false
		}
	}
	s.ws()
	if s.i != len(s.b) || !haveEvent {
		return Frame{}, false
	}
	f.Event = eventOf(eventName)
	if f.Event == EventUnknown {
		return Frame{}, false
	}
	if streamIsStr && len(streamSID) > 0 {
		f.StreamSID = streamSID
	}
	var st startObject
	if start != nil {
		st = parseStart(start)
		if f.StreamSID == nil && st.streamSID != "" {
			f.StreamSID = []byte(st.streamSID)
		}
		f.CallSID = st.callSID
	}
	switch f.Event {
	case EventMedia:
		if !payloadOK {
			return Frame{}, false
		}
		f.Payload = p.payload
	case EventDTMF:
		digit, ok := stringField(dtmf, "digit")
		if !ok {
			return Frame{}, false
		}
		f.DTMFDigit = digit
	case EventMark:
		f.MarkName, _ = stringField(mark, "name")
	case EventStart:
		f.CustomParameters = st.params
		if f.CustomParameters == nil {
			f.CustomParameters = map[string]string{}
		}
	}
	return f, true
}

// media scans the media object for its payload, decoding it into p.payload.
// found reports whether a string payload was present and decoded.
func (p *Parser) media(s *scanner) (ok, found bool) {
	s.ws()
	if s.i >= len(s.b) || s.b[s.i] != '{' {
		return s.skipValue(), false
	}
	s.i++
	if s.consume('}') {
		return true, false
	}
	for {
		key, ok := p.str(s)
		if !ok || !s.consume(':') {
			return false, false
		}
		if string(key) == "payload" {
			v, isStr, ok := p.value(s)
			if !ok {
				return false, false
			}
			found = isStr && p.decodePayload(v)
		} else if !s.skipValue() {
			return false, false
		}
		if s.consume(',') {
			continue
		}
		return s.consume('}'), found
	}
}

// decodePayload base64-decodes b64 into the reused payload buffer. Padding
// is optional, as in the JavaScript SDK's lenient decoder.
func (p *Parser) decodePayload(b64 []byte) bool {
	out, err := base64.StdEncoding.AppendDecode(p.payload[:0], b64)
	if err != nil {
		out, err = base64.RawStdEncoding.AppendDecode(p.payload[:0], b64)
		if err != nil {
			return false
		}
	}
	p.payload = out
	return true
}

// str reads a string at the cursor, unescaped. It returns the raw bytes when
// the string holds no escapes (the common case) and the parser's scratch
// buffer otherwise.
func (p *Parser) str(s *scanner) ([]byte, bool) {
	raw, esc, ok := s.str()
	if !ok || !esc {
		return raw, ok
	}
	p.scratch, ok = appendUnescaped(p.scratch[:0], raw)
	return p.scratch, ok
}

// value reads a value at the cursor: a string (unescaped, isStr true) or any
// other value, skipped.
func (p *Parser) value(s *scanner) (v []byte, isStr, ok bool) {
	s.ws()
	if s.i < len(s.b) && s.b[s.i] == '"' {
		v, ok = p.str(s)
		return v, true, ok
	}
	return nil, false, s.skipValue()
}

type startObject struct {
	streamSID, callSID string
	params             map[string]string
}

// parseStart decodes the start object. Fields of the wrong type are ignored,
// as are non-string custom parameters.
func parseStart(raw []byte) startObject {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return startObject{}
	}
	var st startObject
	_ = json.Unmarshal(fields["streamSid"], &st.streamSID)
	_ = json.Unmarshal(fields["callSid"], &st.callSID)
	var params map[string]json.RawMessage
	if json.Unmarshal(fields["customParameters"], &params) == nil {
		for name, v := range params {
			var s string
			if json.Unmarshal(v, &s) == nil {
				if st.params == nil {
					st.params = make(map[string]string, len(params))
				}
				st.params[name] = s
			}
		}
	}
	return st
}

// stringField returns obj[name] when obj is an object and the field a string.
func stringField(obj []byte, name string) (string, bool) {
	if obj == nil {
		return "", false
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(obj, &fields) != nil {
		return "", false
	}
	raw, ok := fields[name]
	if !ok {
		return "", false
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return "", false
	}
	return s, true
}

// scanner is a minimal JSON tokenizer over one frame.
type scanner struct {
	b []byte
	i int
}

func (s *scanner) ws() {
	for s.i < len(s.b) {
		switch s.b[s.i] {
		case ' ', '\t', '\n', '\r':
			s.i++
		default:
			return
		}
	}
}

func (s *scanner) consume(c byte) bool {
	s.ws()
	if s.i < len(s.b) && s.b[s.i] == c {
		s.i++
		return true
	}
	return false
}

// str reads a string at the cursor and returns its raw contents, without the
// quotes, and whether they contain escapes.
func (s *scanner) str() (raw []byte, esc, ok bool) {
	s.ws()
	b, i := s.b, s.i
	if i >= len(b) || b[i] != '"' {
		return nil, false, false
	}
	i++
	start := i
	for i < len(b) {
		c := b[i]
		if c >= 0x20 && c != '"' && c != '\\' {
			i++
			continue
		}
		switch c {
		case '"':
			s.i = i + 1
			return b[start:i], esc, true
		case '\\':
			esc = true
			i += 2
		default:
			return nil, false, false
		}
	}
	return nil, false, false
}

// rawValue skips the value at the cursor and returns its bytes.
func (s *scanner) rawValue() ([]byte, bool) {
	s.ws()
	start := s.i
	if !s.skipValue() {
		return nil, false
	}
	return s.b[start:s.i], true
}

// skipValue skips one value of any type.
func (s *scanner) skipValue() bool {
	s.ws()
	if s.i >= len(s.b) {
		return false
	}
	switch s.b[s.i] {
	case '"':
		_, _, ok := s.str()
		return ok
	case '{':
		s.i++
		if s.consume('}') {
			return true
		}
		for {
			if _, _, ok := s.str(); !ok || !s.consume(':') || !s.skipValue() {
				return false
			}
			if s.consume(',') {
				continue
			}
			return s.consume('}')
		}
	case '[':
		s.i++
		if s.consume(']') {
			return true
		}
		for {
			if !s.skipValue() {
				return false
			}
			if s.consume(',') {
				continue
			}
			return s.consume(']')
		}
	}
	start := s.i
	for s.i < len(s.b) && isLiteralByte(s.b[s.i]) {
		s.i++
	}
	switch lit := s.b[start:s.i]; string(lit) {
	case "":
		return false
	case "true", "false", "null":
		return true
	default:
		return isNumber(lit)
	}
}

func isLiteralByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '+' || c == '.' || c == 'E'
}

// isNumber reports whether b is a JSON number:
// -?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?
func isNumber(b []byte) bool {
	i := 0
	if i < len(b) && b[i] == '-' {
		i++
	}
	switch {
	case i < len(b) && b[i] == '0':
		i++
	case i < len(b) && b[i] >= '1' && b[i] <= '9':
		i = digits(b, i)
	default:
		return false
	}
	if i < len(b) && b[i] == '.' {
		if j := digits(b, i+1); j > i+1 {
			i = j
		} else {
			return false
		}
	}
	if i < len(b) && (b[i] == 'e' || b[i] == 'E') {
		i++
		if i < len(b) && (b[i] == '+' || b[i] == '-') {
			i++
		}
		j := digits(b, i)
		if j == i {
			return false
		}
		i = j
	}
	return i == len(b)
}

func digits(b []byte, i int) int {
	for i < len(b) && b[i] >= '0' && b[i] <= '9' {
		i++
	}
	return i
}

// appendUnescaped decodes the JSON escapes in raw and appends the result.
func appendUnescaped(dst, raw []byte) ([]byte, bool) {
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if c != '\\' {
			dst = append(dst, c)
			continue
		}
		i++
		if i >= len(raw) {
			return dst, false
		}
		switch raw[i] {
		case '"', '\\', '/':
			dst = append(dst, raw[i])
		case 'b':
			dst = append(dst, '\b')
		case 'f':
			dst = append(dst, '\f')
		case 'n':
			dst = append(dst, '\n')
		case 'r':
			dst = append(dst, '\r')
		case 't':
			dst = append(dst, '\t')
		case 'u':
			r, n, ok := decodeU(raw[i+1:])
			if !ok {
				return dst, false
			}
			i += n
			dst = utf8.AppendRune(dst, r)
		default:
			return dst, false
		}
	}
	return dst, true
}

// decodeU decodes the hex digits after \u, joining a surrogate pair. n is
// how many bytes after the 'u' were consumed.
func decodeU(b []byte) (r rune, n int, ok bool) {
	r1, ok := hex4(b)
	if !ok {
		return 0, 0, false
	}
	if utf16.IsSurrogate(r1) && len(b) >= 10 && b[4] == '\\' && b[5] == 'u' {
		if r2, ok := hex4(b[6:]); ok {
			if r := utf16.DecodeRune(r1, r2); r != utf8.RuneError {
				return r, 10, true
			}
		}
	}
	if utf16.IsSurrogate(r1) {
		return utf8.RuneError, 4, true
	}
	return r1, 4, true
}

func hex4(b []byte) (rune, bool) {
	if len(b) < 4 {
		return 0, false
	}
	var r rune
	for _, c := range b[:4] {
		switch {
		case c >= '0' && c <= '9':
			r = r<<4 | rune(c-'0')
		case c >= 'a' && c <= 'f':
			r = r<<4 | rune(c-'a'+10)
		case c >= 'A' && c <= 'F':
			r = r<<4 | rune(c-'A'+10)
		default:
			return 0, false
		}
	}
	return r, true
}
