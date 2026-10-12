package openai

import (
	"encoding/json"
	"strings"
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

func TestDataURLsGetAMediaType(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\n0000")
	enc, err := json.Marshal(ToOpenAIMessages([]scenario.Message{{Role: scenario.RoleUser, Parts: []scenario.Part{
		scenario.ImagePart("", png),
		scenario.FilePart("", []byte("%PDF-1.7\n"), "doc"),
	}}}))
	if err != nil {
		t.Fatal(err)
	}
	body := string(enc)
	if strings.Contains(body, "data:;") {
		t.Fatalf("data URL without a media type: %s", body)
	}
	for _, want := range []string{`"url":"data:image/png;base64,`, `"file_data":"data:application/pdf;base64,`} {
		if !strings.Contains(body, want) {
			t.Errorf("request lacks %s:\n%s", want, body)
		}
	}
}

// A user message none of whose parts can be sent must not become an empty
// content array.
func TestAUserMessageOfUnsupportedPartsIsNotEmpty(t *testing.T) {
	cases := []struct {
		parts []scenario.Part
		want  string
	}{
		{[]scenario.Part{scenario.AudioPart("audio/ogg", []byte{1})}, `"content":"[audio message]"`},
		{[]scenario.Part{{Type: scenario.PartFile, URL: "https://example.com/a.pdf"}}, `"content":"[unsupported content]"`},
	}
	for _, c := range cases {
		enc, err := json.Marshal(ToOpenAIMessages([]scenario.Message{{Role: scenario.RoleUser, Parts: c.parts}}))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(enc), c.want) {
			t.Errorf("message %s, want %s", enc, c.want)
		}
	}
}
