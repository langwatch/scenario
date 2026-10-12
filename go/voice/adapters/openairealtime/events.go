package openairealtime

import (
	"encoding/base64"
	"encoding/json"

	"github.com/langwatch/scenario/go/voice/broker"
	"github.com/langwatch/scenario/go/voice/internal/jsonscan"
)

// Server event types the adapter reads. GA names are
// response.output_audio[_transcript].*; the Beta response.audio[_transcript].*
// names are accepted too so a Beta endpoint keeps working.
const (
	evAudioDelta           = "response.output_audio.delta"
	evAudioDeltaBeta       = "response.audio.delta"
	evTranscriptDelta      = "response.output_audio_transcript.delta"
	evTranscriptDeltaBeta  = "response.audio_transcript.delta"
	evTranscriptDone       = "response.output_audio_transcript.done"
	evTranscriptDoneBeta   = "response.audio_transcript.done"
	evInputTranscription   = "conversation.item.input_audio_transcription.completed"
	evFunctionArgsDelta    = "response.function_call_arguments.delta"
	evFunctionArgsDone     = "response.function_call_arguments.done"
	evOutputItemAdded      = "response.output_item.added"
	evOutputItemDone       = "response.output_item.done"
	evResponseCreated      = "response.created"
	evResponseDone         = "response.done"
	evResponseCancelled    = "response.cancelled"
	evError                = "error"
	itemTypeFunctionCall   = "function_call"
	clientAudioAppendStart = `{"type":"input_audio_buffer.append","audio":"`
)

// event is one decoded server event. Audio deltas carry their decoded PCM;
// every other field is set from the control event's JSON.
type event struct {
	Type       string          `json:"type"`
	Delta      string          `json:"delta"`
	Transcript string          `json:"transcript"`
	CallID     string          `json:"call_id"`
	Name       string          `json:"name"`
	Arguments  string          `json:"arguments"`
	Item       *outputItem     `json:"item"`
	Error      json.RawMessage `json:"error"`
	Response   *struct {
		Usage json.RawMessage `json:"usage"`
	} `json:"response"`

	audio []byte
}

type outputItem struct {
	Type      string `json:"type"`
	CallID    string `json:"call_id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// decodeEvent decodes a server frame. Audio deltas take the fast path: the
// base64 payload is decoded straight from the frame, the one allocation
// being the PCM the returned chunk owns. Frames that are not JSON objects are
// dropped (ok false), as the JavaScript adapter does.
func decodeEvent(frame []byte) (event, bool) {
	if ev, ok := decodeAudioDelta(frame); ok {
		return ev, true
	}
	var ev event
	if json.Unmarshal(frame, &ev) != nil {
		return event{}, false
	}
	return ev, true
}

// decodeAudioDelta is the allocation-lean path for audio delta frames.
func decodeAudioDelta(frame []byte) (event, bool) {
	var typ string
	var delta []byte
	escaped := false
	walked := jsonscan.Fields(frame, func(k, v []byte) bool {
		switch string(k) {
		case "type":
			switch string(v) {
			case `"` + evAudioDelta + `"`:
				typ = evAudioDelta
			case `"` + evAudioDeltaBeta + `"`:
				typ = evAudioDeltaBeta
			default:
				return false
			}
		case "delta":
			s, esc, ok := jsonscan.String(v)
			if ok {
				delta, escaped = s, esc
			}
		}
		return true
	})
	if !walked || typ == "" {
		return event{}, false
	}
	if escaped {
		// A JSON escape inside base64 (an encoder writing "\/"): decode the
		// string the slow way.
		var s string
		if json.Unmarshal(append(append([]byte{'"'}, delta...), '"'), &s) != nil {
			return event{}, false
		}
		delta = []byte(s)
	}
	pcm := make([]byte, base64.StdEncoding.DecodedLen(len(delta)))
	// Lenient like Node's Buffer.from(…, "base64"): keep what decoded.
	n, _ := base64.StdEncoding.Decode(pcm, delta)
	return event{Type: typ, audio: pcm[:n:n]}, true
}

// errorMessage is the message of an "error" event: error.message, else the
// error object's JSON.
func (e *event) errorMessage() string {
	var detail struct {
		Message *string `json:"message"`
	}
	if len(e.Error) > 0 && json.Unmarshal(e.Error, &detail) == nil && detail.Message != nil {
		return *detail.Message
	}
	if len(e.Error) == 0 || string(e.Error) == "null" {
		return "{}"
	}
	return string(e.Error)
}

// usage is the usage object of a response.done event, if any.
func (e *event) usage() (broker.Usage, bool) {
	if e.Type != evResponseDone || e.Response == nil || len(e.Response.Usage) == 0 {
		return nil, false
	}
	var u broker.Usage
	if json.Unmarshal(e.Response.Usage, &u) != nil || u == nil {
		return nil, false
	}
	return u, true
}

// appendAudioFrame appends the input_audio_buffer.append frame carrying pcm
// to dst, base64-encoding in place.
func appendAudioFrame(dst, pcm []byte) []byte {
	dst = append(dst, clientAudioAppendStart...)
	dst = base64.StdEncoding.AppendEncode(dst, pcm)
	return append(dst, `"}`...)
}
