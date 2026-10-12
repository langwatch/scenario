package geminilive

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"

	"github.com/langwatch/scenario/go/voice/audio"
	"github.com/langwatch/scenario/go/voice/internal/jsmath"
	"github.com/langwatch/scenario/go/voice/internal/jsonscan"
)

// serverMessage is the part of a Live server message the adapter reads.
type serverMessage struct {
	// goAway is the raw goAway payload, when the server sent one.
	goAway string
	// hasContent reports a serverContent member.
	hasContent   bool
	interrupted  bool
	turnComplete bool
	// transcript is the outputTranscription text.
	transcript string
	// audio is the PCM16 of every modelTurn inline-data part, concatenated,
	// trimmed to whole samples.
	audio []byte
}

// decodeServerMessage reads a server message without decoding the JSON
// into a tree: the base64 audio is decoded straight from the frame, the one
// allocation being the PCM the chunk owns. ok is false for a frame that is
// not a JSON object.
func decodeServerMessage(frame []byte) (m serverMessage, ok bool) {
	ok = jsonscan.Fields(frame, func(k, v []byte) bool {
		switch string(k) {
		case "goAway":
			if !jsonscan.IsNull(v) {
				m.goAway = string(v)
			}
		case "serverContent":
			m.hasContent = !jsonscan.IsNull(v)
			jsonscan.Fields(v, func(k, v []byte) bool {
				switch string(k) {
				case "interrupted":
					m.interrupted = jsonscan.IsTrue(v)
				case "turnComplete":
					m.turnComplete = jsonscan.IsTrue(v)
				case "outputTranscription":
					if text, found := jsonscan.Field(v, "text"); found {
						m.transcript = decodeString(text)
					}
				case "modelTurn":
					if parts, found := jsonscan.Field(v, "parts"); found {
						jsonscan.Elements(parts, func(part []byte) bool {
							m.audio = appendInlineData(m.audio, part)
							return true
						})
					}
				}
				return true
			})
		}
		return true
	})
	if len(m.audio)%2 == 1 {
		m.audio = m.audio[:len(m.audio)-1]
	}
	return m, ok
}

// appendInlineData appends the decoded inlineData.data of a part.
func appendInlineData(dst, part []byte) []byte {
	inline, ok := jsonscan.Field(part, "inlineData")
	if !ok {
		return dst
	}
	raw, ok := jsonscan.Field(inline, "data")
	if !ok {
		return dst
	}
	s, escaped, ok := jsonscan.String(raw)
	if !ok || len(s) == 0 {
		return dst
	}
	if escaped {
		s = []byte(decodeString(raw))
	}
	// Lenient like Node's Buffer.from(…, "base64"): keep what decoded.
	out, _ := base64.StdEncoding.AppendDecode(dst, s)
	return out
}

// decodeString decodes a raw JSON string value; anything else is "".
func decodeString(raw []byte) string {
	if s, escaped, ok := jsonscan.String(raw); ok && !escaped {
		return string(s)
	}
	var s string
	_ = json.Unmarshal(raw, &s)
	return s
}

const audioFrameStart = `{"realtimeInput":{"audio":{"data":"`

// appendAudioFrame appends the realtimeInput audio frame carrying the
// 16 kHz PCM16 pcm to dst, base64-encoding in place.
func appendAudioFrame(dst, pcm []byte) []byte {
	dst = append(dst, audioFrameStart...)
	dst = base64.StdEncoding.AppendEncode(dst, pcm)
	return append(dst, `","mimeType":"audio/pcm;rate=16000"}}}`...)
}

// appendResampled appends mono PCM16 resampled from fromRate to toRate by
// linear interpolation, the JavaScript Gemini adapter's resampler sample for
// sample: floor(n·to/from) output samples spread evenly over the input's
// endpoints. A sub-sample result is empty.
func appendResampled(dst, pcm []byte, fromRate, toRate int) []byte {
	n := len(pcm) / 2
	if fromRate == toRate || n == 0 {
		return append(dst, pcm[:2*n]...)
	}
	out := n * toRate / fromRate
	if out == 0 {
		return dst
	}
	off := len(dst)
	dst = audio.Extend(dst, 2*out)
	o := dst[off:]
	if n == 1 {
		s := binary.LittleEndian.Uint16(pcm)
		for i := range out {
			binary.LittleEndian.PutUint16(o[2*i:], s)
		}
		return dst
	}
	step := float64(n-1) / float64(max(out-1, 1))
	last := n - 1
	for i := range out {
		pos := float64(float64(i) * step)
		idx := int(pos)
		frac := pos - float64(idx)
		a := float64(int16(binary.LittleEndian.Uint16(pcm[2*idx:])))
		b := float64(int16(binary.LittleEndian.Uint16(pcm[2*min(idx+1, last):])))
		// The explicit conversion stops a fused multiply-add rounding
		// differently from JavaScript.
		v := jsmath.Round(a + float64((b-a)*frac))
		binary.LittleEndian.PutUint16(o[2*i:], uint16(int16(v)))
	}
	return dst
}
