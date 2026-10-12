package anthropic

import (
	"encoding/json"
	"strings"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

// The API rejects empty text blocks: an empty tool result goes without
// content and an empty system message is dropped.
func TestEmptyToolResultsAndSystemMessagesSendNoEmptyText(t *testing.T) {
	system, rest := splitSystem([]scenario.Message{scenario.SystemMsg(""), scenario.SystemMsg("sys"), scenario.UserMsg("hi")})
	if len(system) != 1 || system[0].Text != "sys" || len(rest) != 1 {
		t.Fatalf("system %+v, rest %+v", system, rest)
	}
	failed := scenario.ToolMsg("b", "")
	failed.IsError = true
	enc, err := json.Marshal(ToAnthropicMessages([]scenario.Message{scenario.ToolMsg("a", ""), failed}))
	if err != nil {
		t.Fatal(err)
	}
	body := string(enc)
	if strings.Contains(body, `"text":""`) || strings.Contains(body, `"content":[]`) {
		t.Fatalf("empty content sent: %s", body)
	}
	for _, want := range []string{`{"tool_use_id":"a","is_error":false,"type":"tool_result"}`, `{"tool_use_id":"b","is_error":true,"type":"tool_result"}`} {
		if !strings.Contains(body, want) {
			t.Errorf("request lacks %s:\n%s", want, body)
		}
	}
}

func TestInlineImagesGetAMediaType(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\n0000")
	msgs := ToAnthropicMessages([]scenario.Message{{Role: scenario.RoleUser, Parts: []scenario.Part{
		scenario.ImagePart("", png),
		scenario.ImagePart("image/jpg", []byte{0xff, 0xd8, 0xff}),
	}}})
	got := []string{
		string(msgs[0].Content[0].OfImage.Source.OfBase64.MediaType),
		string(msgs[0].Content[1].OfImage.Source.OfBase64.MediaType),
	}
	if got[0] != "image/png" || got[1] != "image/jpeg" {
		t.Fatalf("media types = %q", got)
	}
}
