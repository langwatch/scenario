package elevenlabs

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strconv"
)

// Wire identity. The query suffix the official JavaScript SDK
// (@elevenlabs/elevenlabs-js 2.64.0) appends to the signed URL, kept
// byte-for-byte so the server sees the same session the JS adapter opens.
const (
	wireSource  = "js_sdk"
	wireVersion = "2.64.0"
	// signedURLPath is the REST route minting the session URL of a private
	// agent, joined onto the base URL.
	signedURLPath = "v1/convai/conversation/get-signed-url"
	// maxMessageBytes is the SDK's maxPayload (16 MB).
	maxMessageBytes = 16 << 20
)

// Client-to-server event types.
const (
	evPong             = "pong"
	evClientToolResult = "client_tool_result"
	evInitClientData   = "conversation_initiation_client_data"
	evContextualUpdate = "contextual_update"
	evUserMessage      = "user_message"
)

// Server-to-client event types the transport routes.
const (
	evInitMetadata       = "conversation_initiation_metadata"
	evAudio              = "audio"
	evAgentResponse      = "agent_response"
	evAgentCorrection    = "agent_response_correction"
	evUserTranscript     = "user_transcript"
	evInterruption       = "interruption"
	evPing               = "ping"
	evClientToolCall     = "client_tool_call"
	evAgentToolRequest   = "agent_tool_request"
	evAgentToolResponse  = "agent_tool_response"
	evMCPToolCall        = "mcp_tool_call"
	evVADScore           = "vad_score"
	evContextUsage       = "context_usage"
	evAgentChatPart      = "agent_chat_response_part"
	evAgentRespMetadata  = "agent_response_metadata"
	evInternalTentative  = "internal_tentative_agent_response"
	evUnknown            = "unknown"
	canonicalAudioFormat = "pcm_24000"
)

// internType returns a constant string for a known event type, so counting
// frames by type allocates nothing on the hot path.
func internType(b []byte) string {
	switch string(b) {
	case evAudio:
		return evAudio
	case evPing:
		return evPing
	case evVADScore:
		return evVADScore
	case evAgentResponse:
		return evAgentResponse
	case evAgentCorrection:
		return evAgentCorrection
	case evUserTranscript:
		return evUserTranscript
	case evInterruption:
		return evInterruption
	case evInitMetadata:
		return evInitMetadata
	case evClientToolCall:
		return evClientToolCall
	case evAgentToolRequest:
		return evAgentToolRequest
	case evAgentToolResponse:
		return evAgentToolResponse
	case evMCPToolCall:
		return evMCPToolCall
	case evContextUsage:
		return evContextUsage
	case evAgentChatPart:
		return evAgentChatPart
	case evAgentRespMetadata:
		return evAgentRespMetadata
	case evInternalTentative:
		return evInternalTentative
	}
	return string(b)
}

// ---------------------------------------------------------------- outbound

// initClientData is the first frame of a session. Field order and omission
// follow the SDK's JSON.stringify of its init event: keys the adapter leaves
// undefined (custom_llm_extra_body, environment, unset dynamic_variables) are
// absent.
type initClientData struct {
	Type                       string         `json:"type"`
	ConversationConfigOverride map[string]any `json:"conversation_config_override"`
	DynamicVariables           map[string]any `json:"dynamic_variables,omitzero"`
}

func encodeInit(override, dynamicVariables map[string]any) ([]byte, error) {
	if override == nil {
		override = map[string]any{}
	}
	return json.Marshal(initClientData{Type: evInitClientData, ConversationConfigOverride: override, DynamicVariables: dynamicVariables})
}

type textEvent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

func encodeText(eventType, text string) ([]byte, error) {
	return json.Marshal(textEvent{Type: eventType, Text: text})
}

type clientToolResult struct {
	Type       string `json:"type"`
	ToolCallID string `json:"tool_call_id"`
	Result     string `json:"result"`
	IsError    bool   `json:"is_error"`
}

// encodeUnregisteredToolResult is the SDK's reply to a client tool call no
// handler is registered for (this transport registers none).
func encodeUnregisteredToolResult(toolName string, toolCallID json.RawMessage) ([]byte, error) {
	var id string
	_ = json.Unmarshal(toolCallID, &id)
	return json.Marshal(clientToolResult{
		Type: evClientToolResult, ToolCallID: id,
		Result: "Tool '" + toolName + "' is not registered", IsError: true,
	})
}

const audioChunkPrefix = `{"user_audio_chunk":"`

// appendUserAudioChunk appends the user_audio_chunk frame carrying pcm to
// dst. It allocates nothing when dst has room.
func appendUserAudioChunk(dst, pcm []byte) []byte {
	dst = append(dst, audioChunkPrefix...)
	dst = base64.StdEncoding.AppendEncode(dst, pcm)
	return append(dst, `"}`...)
}

// userAudioChunkLen is the encoded length of a user_audio_chunk frame for
// n PCM bytes.
func userAudioChunkLen(n int) int {
	return len(audioChunkPrefix) + base64.StdEncoding.EncodedLen(n) + 2
}

// appendPong appends the pong answering a ping; eventID is the ping's raw
// event_id value (number or string), echoed unchanged.
func appendPong(dst, eventID []byte) []byte {
	dst = append(dst, `{"type":"pong","event_id":`...)
	if len(eventID) == 0 {
		eventID = []byte("null")
	}
	dst = append(dst, eventID...)
	return append(dst, '}')
}

// ----------------------------------------------------------------- inbound

// inboundFrame is the routing view of one server message: its type and the
// raw values the hot path reads without a full decode.
type inboundFrame struct {
	typ []byte
	// audio_event members.
	audioB64     []byte
	audioEventID []byte
	// ping_event.event_id and interruption_event.event_id.
	eventID []byte
}

// parseFrame scans one server message. It returns false for anything that
// is not a JSON object.
func parseFrame(data []byte, f *inboundFrame) bool {
	*f = inboundFrame{}
	return eachMember(data, func(key, val []byte) bool {
		switch string(key) {
		case "type":
			s, ok := rawString(val)
			if !ok {
				return false
			}
			f.typ = s
		case "audio_event":
			return eachMember(val, func(k, v []byte) bool {
				switch string(k) {
				case "audio_base_64":
					s, ok := rawString(v)
					if !ok {
						return false
					}
					f.audioB64 = s
				case "event_id":
					f.audioEventID = v
				}
				return true
			})
		case "ping_event", "interruption_event":
			return eachMember(val, func(k, v []byte) bool {
				if string(k) == "event_id" {
					f.eventID = v
				}
				return true
			})
		}
		return true
	})
}

// decodeAudio decodes base64 PCM into a new slice, trimming a stray odd
// byte so the PCM16 sample invariant holds. The slice is the only
// allocation: it leaves the transport as the chunk's data.
func decodeAudio(b64 []byte) ([]byte, error) {
	pcm := make([]byte, base64.StdEncoding.DecodedLen(len(b64)))
	n, err := base64.StdEncoding.Decode(pcm, b64)
	if err != nil {
		return nil, err
	}
	return pcm[: n&^1 : n&^1], nil
}

// parseEventID is JavaScript's parseInt over an event_id that may be a JSON
// number or a numeric string. ok is false where parseInt yields NaN.
func parseEventID(raw []byte) (int64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	if raw[0] == '"' {
		s, ok := rawString(raw)
		if !ok {
			return 0, false
		}
		raw = bytes.TrimLeft(s, " \t\n\r")
	}
	end := 0
	if end < len(raw) && (raw[end] == '-' || raw[end] == '+') {
		end++
	}
	digits := end
	for end < len(raw) && raw[end] >= '0' && raw[end] <= '9' {
		end++
	}
	if end == digits {
		return 0, false
	}
	n, err := strconv.ParseInt(string(raw[:end]), 10, 64)
	return n, err == nil
}

// ------------------------------------------------------------ JSON scanning

// eachMember calls fn with the raw key (still escaped, without quotes) and
// the raw value of each member of the JSON object in data. It stops when fn
// returns false and reports whether data was a well-formed object as far as
// it was scanned. It allocates nothing.
func eachMember(data []byte, fn func(key, val []byte) bool) bool {
	i := skipSpace(data, 0)
	if i >= len(data) || data[i] != '{' {
		return false
	}
	i = skipSpace(data, i+1)
	if i < len(data) && data[i] == '}' {
		return true
	}
	for i < len(data) {
		if data[i] != '"' {
			return false
		}
		kEnd, ok := skipString(data, i)
		if !ok {
			return false
		}
		key := data[i+1 : kEnd-1]
		i = skipSpace(data, kEnd)
		if i >= len(data) || data[i] != ':' {
			return false
		}
		i = skipSpace(data, i+1)
		vEnd, ok := skipValue(data, i)
		if !ok {
			return false
		}
		if !fn(key, data[i:vEnd]) {
			return false
		}
		i = skipSpace(data, vEnd)
		if i >= len(data) {
			return false
		}
		switch data[i] {
		case ',':
			i = skipSpace(data, i+1)
		case '}':
			return true
		default:
			return false
		}
	}
	return false
}

func skipSpace(data []byte, i int) int {
	for i < len(data) && (data[i] == ' ' || data[i] == '\t' || data[i] == '\n' || data[i] == '\r') {
		i++
	}
	return i
}

// skipString returns the index just past the string starting at data[i].
// It jumps from quote to quote, so a long base64 payload costs one
// vectorised scan.
func skipString(data []byte, i int) (int, bool) {
	for j := i + 1; ; {
		k := bytes.IndexByte(data[j:], '"')
		if k < 0 {
			return 0, false
		}
		q := j + k
		backslashes := 0
		for p := q - 1; p > i && data[p] == '\\'; p-- {
			backslashes++
		}
		if backslashes%2 == 0 {
			return q + 1, true
		}
		j = q + 1
	}
}

// skipValue returns the index just past the value starting at data[i].
func skipValue(data []byte, i int) (int, bool) {
	if i >= len(data) {
		return 0, false
	}
	switch data[i] {
	case '"':
		return skipString(data, i)
	case '{', '[':
		depth := 0
		for j := i; j < len(data); j++ {
			switch data[j] {
			case '"':
				end, ok := skipString(data, j)
				if !ok {
					return 0, false
				}
				j = end - 1
			case '{', '[':
				depth++
			case '}', ']':
				depth--
				if depth == 0 {
					return j + 1, true
				}
			}
		}
		return 0, false
	}
	j := i
	for j < len(data) && data[j] != ',' && data[j] != '}' && data[j] != ']' &&
		data[j] != ' ' && data[j] != '\t' && data[j] != '\n' && data[j] != '\r' {
		j++
	}
	return j, j > i
}

// rawString returns the content of a JSON string value. Strings without
// escapes are returned in place; escaped ones are decoded (the rare path).
func rawString(val []byte) ([]byte, bool) {
	if len(val) < 2 || val[0] != '"' || val[len(val)-1] != '"' {
		return nil, false
	}
	inner := val[1 : len(val)-1]
	if bytes.IndexByte(inner, '\\') < 0 {
		return inner, true
	}
	var s string
	if err := json.Unmarshal(val, &s); err != nil {
		return nil, false
	}
	return []byte(s), true
}
