package elevenlabs

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
)

// protocolFixture is testdata/protocol.json: the pinned wire shapes.
type protocolFixture struct {
	SignedURL struct {
		Method, Path, Query string
		AuthHeader          string          `json:"auth_header"`
		Response            json.RawMessage `json:"response"`
		DialURL             string          `json:"dial_url"`
		DialURLWithoutQuery string          `json:"dial_url_without_query"`
	} `json:"signed_url"`
	Outbound map[string]json.RawMessage `json:"outbound"`
	Inbound  []struct {
		Frame  json.RawMessage `json:"frame"`
		Expect map[string]any  `json:"expect"`
	} `json:"inbound"`
}

func loadFixture(t *testing.T) protocolFixture {
	t.Helper()
	data, err := os.ReadFile("testdata/protocol.json")
	if err != nil {
		t.Fatal(err)
	}
	var f protocolFixture
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func compact(t *testing.T, raw []byte) string {
	t.Helper()
	var b bytes.Buffer
	if err := json.Compact(&b, raw); err != nil {
		t.Fatal(err)
	}
	return b.String()
}

// TestOutboundShapesMatchTheFixture is the shape guard: each message the
// transport sends must encode byte for byte as pinned.
func TestOutboundShapesMatchTheFixture(t *testing.T) {
	t.Parallel()
	fx := loadFixture(t)
	full := Options{
		SystemPromptOverride: "X", FirstMessageOverride: "Hi",
		Overrides:        map[string]any{"agent": map[string]any{"language": "es", "prompt": map[string]any{"prompt": "Y"}}, "tts": map[string]any{"stability": 0.4}},
		DynamicVariables: map[string]any{"tenant_id": "acme", "tier": 2, "vip": true},
	}
	encoders := map[string]func() ([]byte, error){
		"init_minimal": func() ([]byte, error) { return encodeInit(Options{}.conversationConfigOverride(), nil) },
		"init_full": func() ([]byte, error) {
			return encodeInit(full.conversationConfigOverride(), full.DynamicVariables)
		},
		"user_audio_chunk": func() ([]byte, error) {
			return appendUserAudioChunk(nil, []byte{0x10, 0, 0x20, 0, 0x30, 0, 0x40, 0}), nil
		},
		"pong_number":       func() ([]byte, error) { return appendPong(nil, []byte("42")), nil },
		"pong_string":       func() ([]byte, error) { return appendPong(nil, []byte(`"7"`)), nil },
		"user_message":      func() ([]byte, error) { return encodeText(evUserMessage, "hello there") },
		"contextual_update": func() ([]byte, error) { return encodeText(evContextualUpdate, "the user is on the pricing page") },
		"client_tool_result": func() ([]byte, error) {
			return encodeUnregisteredToolResult("lookup_order", json.RawMessage(`"call_1"`))
		},
	}
	if len(encoders) != len(fx.Outbound) {
		t.Fatalf("fixture pins %d outbound shapes, the test encodes %d", len(fx.Outbound), len(encoders))
	}
	for name, want := range fx.Outbound {
		enc, ok := encoders[name]
		if !ok {
			t.Errorf("no encoder for pinned shape %q", name)
			continue
		}
		got, err := enc()
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if g, w := string(got), compact(t, want); g != w {
			t.Errorf("%s drifted from the pinned shape:\n got %s\nwant %s", name, g, w)
		}
	}
}

func TestSignedURLShapeMatchesTheFixture(t *testing.T) {
	t.Parallel()
	fx := loadFixture(t).SignedURL
	var res struct {
		SignedURL string `json:"signed_url"`
	}
	if err := json.Unmarshal(fx.Response, &res); err != nil {
		t.Fatal(err)
	}
	if got := withSDKQuery(res.SignedURL); got != fx.DialURL {
		t.Fatalf("dial URL %q, want %q", got, fx.DialURL)
	}
	if got := withSDKQuery("wss://gw.example/convai"); got != fx.DialURLWithoutQuery {
		t.Fatalf("dial URL %q, want %q", got, fx.DialURLWithoutQuery)
	}

	// The mint request itself, as the transport sends it.
	var gotReq *http.Request
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		gotReq = r
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: ioNopCloser(string(fx.Response))}, nil
	})}
	tr := must(New(Options{AgentID: "agt_1", APIKey: "sk", BaseURL: "https://api.elevenlabs.io", HTTPClient: client}))
	dial, err := tr.signedURL(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if gotReq.Method != fx.Method || gotReq.URL.Path != fx.Path || gotReq.URL.RawQuery != fx.Query || gotReq.Header.Get(fx.AuthHeader) != "sk" {
		t.Fatalf("mint request %s %s?%s", gotReq.Method, gotReq.URL.Path, gotReq.URL.RawQuery)
	}
	if dial != fx.DialURL {
		t.Fatalf("dial URL %q", dial)
	}
}

// TestInboundShapesMatchTheFixture checks every pinned server message is
// read as the transport needs it.
func TestInboundShapesMatchTheFixture(t *testing.T) {
	t.Parallel()
	for _, c := range loadFixture(t).Inbound {
		got := describeInbound(t, c.Frame)
		want := map[string]any{}
		for k, v := range c.Expect {
			want[k] = v
		}
		if !reflect.DeepEqual(normalize(t, got), normalize(t, want)) {
			t.Errorf("frame %s\n read as %v\n    want %v", c.Frame, got, want)
		}
	}
}

// describeInbound reads frame with the transport's own decoders.
func describeInbound(t *testing.T, frame []byte) map[string]any {
	t.Helper()
	var f inboundFrame
	if !parseFrame(frame, &f) {
		t.Fatalf("frame not parsed: %s", frame)
	}
	etype := internType(f.typ)
	out := map[string]any{"type": etype}
	var ev controlEvent
	if needsDecode(etype) {
		if err := json.Unmarshal(frame, &ev); err != nil {
			t.Fatal(err)
		}
	}
	switch etype {
	case evAudio:
		pcm, err := decodeAudio(f.audioB64)
		if err != nil {
			t.Fatal(err)
		}
		out["audio_hex"] = hex.EncodeToString(pcm)
		if id, ok := parseEventID(f.audioEventID); ok {
			out["event_id"] = id
		}
	case evInterruption:
		id, _ := parseEventID(f.eventID)
		out["event_id"] = id
	case evPing:
		id, _ := parseEventID(f.eventID)
		out["event_id"] = id
		out["pong"] = json.RawMessage(appendPong(nil, f.eventID))
	case evClientToolCall:
		var call struct {
			ClientToolCall struct {
				ToolName   string          `json:"tool_name"`
				ToolCallID json.RawMessage `json:"tool_call_id"`
			} `json:"client_tool_call"`
		}
		_ = json.Unmarshal(frame, &call)
		reply, _ := encodeUnregisteredToolResult(call.ClientToolCall.ToolName, call.ClientToolCall.ToolCallID)
		out["reply"] = json.RawMessage(reply)
	case evInitMetadata:
		out["conversation_id"] = ev.Metadata.ConversationID
		out["output_format"] = ev.Metadata.OutputFormat
		out["input_format"] = ev.Metadata.InputFormat
	case evAgentResponse:
		out["agent_response"] = strings.TrimSpace(ev.AgentResponse.Text)
	case evAgentCorrection:
		out["corrected"] = strings.TrimSpace(ev.Correction.Corrected)
	case evUserTranscript:
		out["user_transcript"] = ev.UserTranscript.Text
	case evAgentToolResponse:
		tr := ev.ToolResponse
		out["tool_name"] = tr.ToolName
		out["hangup"] = hangupTools[tr.ToolName] && isTrue(tr.IsCalled) && !isTrue(tr.IsError) && !isTrue(tr.IsBlocked)
	}
	return out
}

// normalize round-trips v through JSON so numbers and nested objects
// compare equal however they were built.
func normalize(t *testing.T, v map[string]any) any {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	_ = json.Unmarshal(data, &out)
	return out
}

func TestParseFrameEdgeCases(t *testing.T) {
	t.Parallel()
	var f inboundFrame
	for _, bad := range []string{"not-json", "", "[1,2]", `{"type":`, `{"type":"audio"`, `{"type":1}`} {
		if parseFrame([]byte(bad), &f) {
			t.Errorf("parsed %q", bad)
		}
	}
	// Escaped strings and nested look-alike keys.
	if !parseFrame([]byte(` { "x":{"type":"no"} , "type" : "agent_chat_response_part", "y":[{"type":"z"}] } `), &f) ||
		string(f.typ) != "agent_chat_response_part" {
		t.Fatalf("type %q", f.typ)
	}
	// A slash escaped in the base64 payload takes the decoding path.
	if !parseFrame([]byte(`{"type":"audio","audio_event":{"audio_base_64":"AA\/A"}}`), &f) || string(f.audioB64) != "AA/A" {
		t.Fatalf("audio %q", f.audioB64)
	}
	for raw, want := range map[string]int64{`3`: 3, `"12"`: 12, `"7abc"`: 7, `-2`: -2} {
		if got, ok := parseEventID([]byte(raw)); !ok || got != want {
			t.Errorf("parseEventID(%s) = %d %v", raw, got, ok)
		}
	}
	for _, raw := range []string{``, `null`, `"x"`, `{}`} {
		if _, ok := parseEventID([]byte(raw)); ok {
			t.Errorf("parseEventID(%s) parsed", raw)
		}
	}
	if b, _ := base64.StdEncoding.DecodeString("AAE="); len(must(decodeAudio([]byte("AAE=")))) != len(b) {
		t.Fatal("decodeAudio")
	}
}

func ioNopCloser(s string) io.ReadCloser { return io.NopCloser(strings.NewReader(s)) }
