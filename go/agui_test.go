package scenario

import (
	"encoding/base64"
	"testing"
)

func TestAGUIConversion(t *testing.T) {
	cases := []struct {
		name string
		msg  Message
		want string
	}{
		{"user text", Message{ID: "m1", Role: RoleUser, Content: "hi"}, `{"id":"m1","role":"user","content":"hi"}`},
		{"system", Message{ID: "m1", Role: RoleSystem, Content: "be nice"}, `{"id":"m1","role":"system","content":"be nice"}`},
		{"single text part collapses", Message{ID: "m1", Role: RoleUser, Parts: []Part{TextPart("hi")}}, `{"id":"m1","role":"user","content":"hi"}`},
		{"image part", Message{ID: "m1", Role: RoleUser, Parts: []Part{TextPart("what is it"), ImageURLPart("https://x/y.png")}},
			`{"id":"m1","role":"user","content":[{"type":"text","text":"what is it"},{"type":"image","image":"https://x/y.png"}]}`},
		{"assistant tool call only", Message{ID: "m1", Role: RoleAssistant, TraceID: "t1", ToolCalls: []ToolCall{{ID: "c", Name: "f", Arguments: `{"a": [1, 2]}`}}},
			`{"trace_id":"t1","id":"m1","role":"assistant","content":[],"toolCalls":[{"id":"c","type":"function","function":{"name":"f","arguments":"{\"a\":[1,2]}"}}]}`},
		{"assistant text and tool call", Message{ID: "m1", Role: RoleAssistant, Content: "checking", ToolCalls: []ToolCall{{ID: "c", Name: "f", Arguments: "{}"}}},
			`{"id":"m1","role":"assistant","content":"checking","toolCalls":[{"id":"c","type":"function","function":{"name":"f","arguments":"{}"}}]}`},
		{"tool text result is JSON-quoted", Message{ID: "m1", Role: RoleTool, ToolCallID: "c", Content: "sunny"},
			`{"id":"m1-0","role":"tool","toolCallId":"c","content":"\"sunny\""}`},
		{"tool json result", Message{ID: "m1", Role: RoleTool, ToolCallID: "c", Content: `{ "t": 1 }`},
			`{"id":"m1-0","role":"tool","toolCallId":"c","content":"{\"t\":1}"}`},
		{"failed tool result carries no error flag, as in JS", Message{ID: "m1", Role: RoleTool, ToolCallID: "c", Content: "boom", IsError: true},
			`{"id":"m1-0","role":"tool","toolCallId":"c","content":"\"boom\""}`},
		{"wav audio", Message{ID: "m1", Role: RoleUser, Parts: []Part{AudioPart("audio/wav", []byte("RIFFxx"))}},
			`{"id":"m1","role":"user","content":[{"type":"input_audio","input_audio":{"data":"UklGRnh4","format":"wav","mimeType":"audio/wav"}}]}`},
	}
	for _, c := range cases {
		if got := string(aguiRows(c.msg)[0].json); got != c.want {
			t.Errorf("%s:\n got %s\nwant %s", c.name, got, c.want)
		}
	}
}

func TestPCM16IsWrappedInWAV(t *testing.T) {
	for _, n := range []int{0, 1, 2, 3, 100} {
		pcm := make([]byte, n)
		for i := range pcm {
			pcm[i] = byte(i)
		}
		h := wavHeader(n)
		want := base64.StdEncoding.EncodeToString(append(h[:], pcm...))
		if got := string(appendWAVBase64(nil, pcm)); got != want {
			t.Fatalf("n=%d: base64 differs", n)
		}
	}
}

func TestFailedToolResultsUseAISDKErrorOutputs(t *testing.T) {
	cases := []struct {
		msg  Message
		want string
	}{
		{Message{Role: RoleTool, ToolCallID: "c", ToolName: "f", Content: "boom", IsError: true},
			`{"role":"tool","content":[{"type":"tool-result","toolCallId":"c","toolName":"f","output":{"type":"error-text","value":"boom"}}]}`},
		{Message{Role: RoleTool, ToolCallID: "c", ToolName: "f", Content: `{"code":3}`, IsError: true},
			`{"role":"tool","content":[{"type":"tool-result","toolCallId":"c","toolName":"f","output":{"type":"error-json","value":{"code":3}}}]}`},
		{Message{Role: RoleTool, ToolCallID: "c", ToolName: "f", Content: "fine"},
			`{"role":"tool","content":[{"type":"tool-result","toolCallId":"c","toolName":"f","output":{"type":"text","value":"fine"}}]}`},
	}
	for _, c := range cases {
		if got := string(AppendMessageJSON(nil, c.msg)); got != c.want {
			t.Errorf("got  %s\nwant %s", got, c.want)
		}
	}
}
