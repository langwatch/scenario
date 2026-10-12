package bedrock

import (
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
	scenario "github.com/langwatch/scenario/go"
)

// Converse rejects blank text: an empty tool result gets a placeholder and
// an empty system message is dropped.
func TestEmptyToolResultsAndSystemMessagesSendNoBlankText(t *testing.T) {
	system, _ := splitSystem([]scenario.Message{scenario.SystemMsg(" "), scenario.SystemMsg("sys")})
	if len(system) != 1 || system[0].(*types.SystemContentBlockMemberText).Value != "sys" {
		t.Fatalf("system %+v", system)
	}
	msgs := ToBedrockMessages([]scenario.Message{scenario.ToolMsg("a", "")})
	result := msgs[0].Content[0].(*types.ContentBlockMemberToolResult).Value
	if text := result.Content[0].(*types.ToolResultContentBlockMemberText).Value; text != emptyToolResult {
		t.Fatalf("tool result text = %q", text)
	}
}

func TestDocumentsGetAValidNameAndFormat(t *testing.T) {
	cases := []struct {
		part         scenario.Part
		name, format string
	}{
		{scenario.FilePart("application/pdf", []byte("x"), "report.pdf"), "report", "pdf"},
		{scenario.FilePart("text/plain; charset=utf-8", []byte("x"), "my_notes.v2.txt"), "my notes v2", "txt"},
		{scenario.FilePart("text/markdown", []byte("x"), "README.md"), "README", "md"},
		{scenario.FilePart("application/vnd.openxmlformats-officedocument.wordprocessingml.document", []byte("x"), "Q3 (draft) [v1].docx"), "Q3 (draft) [v1]", "docx"},
		{scenario.FilePart("application/vnd.ms-excel", []byte("x"), ""), "document", "xls"},
		{scenario.FilePart("", []byte("x"), "data.csv"), "data", "csv"},
		{scenario.FilePart("text/x-yaml", []byte("x"), "conf.yaml"), "conf yaml", "txt"},
		{scenario.FilePart("application/pdf", []byte("x"), "..."), "document", "pdf"},
	}
	for _, c := range cases {
		msgs := ToBedrockMessages([]scenario.Message{{Role: scenario.RoleUser, Parts: []scenario.Part{c.part}}})
		doc := msgs[0].Content[0].(*types.ContentBlockMemberDocument).Value
		if aws.ToString(doc.Name) != c.name || string(doc.Format) != c.format {
			t.Errorf("%q (%s): name %q format %q, want %q %q", c.part.Filename, c.part.MediaType, aws.ToString(doc.Name), doc.Format, c.name, c.format)
		}
	}
}

func TestImagesGetAValidFormat(t *testing.T) {
	parts := []scenario.Part{
		scenario.ImagePart("image/jpg", []byte{0xff, 0xd8, 0xff}),
		scenario.ImagePart("", []byte("\x89PNG\r\n\x1a\n0000")),
		scenario.ImagePart("image/webp", []byte("x")),
	}
	msgs := ToBedrockMessages([]scenario.Message{{Role: scenario.RoleUser, Parts: parts}})
	want := []types.ImageFormat{types.ImageFormatJpeg, types.ImageFormatPng, types.ImageFormatWebp}
	for i, w := range want {
		if got := msgs[0].Content[i].(*types.ContentBlockMemberImage).Value.Format; got != w {
			t.Errorf("image %d format = %q, want %q", i, got, w)
		}
	}
}

// Converse has no "none" tool choice: the tools go, unless the history has
// tool blocks, which need a tool config.
func TestToolChoiceNoneLeavesTheToolsOut(t *testing.T) {
	tools := []scenario.ToolDefinition{{Name: "f", Parameters: map[string]any{"type": "object"}}}
	none := &scenario.ToolChoice{Type: scenario.ToolChoiceNone}
	req, err := toRequest(scenario.InferenceParams{Model: "m", Messages: []scenario.Message{scenario.UserMsg("hi")}, Tools: tools, ToolChoice: none})
	if err != nil {
		t.Fatal(err)
	}
	if req.ToolConfig != nil {
		t.Fatalf("tool config %+v, want none", req.ToolConfig)
	}
	history := []scenario.Message{
		scenario.UserMsg("hi"),
		{Role: scenario.RoleAssistant, ToolCalls: []scenario.ToolCall{{ID: "a", Name: "f", Arguments: `{}`}}},
		scenario.ToolMsg("a", "done"),
	}
	req, err = toRequest(scenario.InferenceParams{Model: "m", Messages: history, Tools: tools, ToolChoice: none})
	if err != nil {
		t.Fatal(err)
	}
	if req.ToolConfig == nil || len(req.ToolConfig.Tools) != 1 || req.ToolConfig.ToolChoice != nil {
		t.Fatalf("tool config %+v, want the tools and no choice", req.ToolConfig)
	}
}
