package bedrock

import (
	"encoding/json"
	"mime"
	"net/http"
	"path"
	"strings"
	"unicode"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/document"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
	scenario "github.com/langwatch/scenario/go"
)

// splitSystem moves system messages into system blocks; empty ones are
// dropped, as Converse rejects blank text.
func splitSystem(msgs []scenario.Message) ([]types.SystemContentBlock, []scenario.Message) {
	var system []types.SystemContentBlock
	rest := make([]scenario.Message, 0, len(msgs))
	for _, m := range msgs {
		if m.Role == scenario.RoleSystem {
			if text := m.Text(); strings.TrimSpace(text) != "" {
				system = append(system, &types.SystemContentBlockMemberText{Value: text})
			}
			continue
		}
		rest = append(rest, m)
	}
	return system, rest
}

// ToBedrockMessages converts scenario messages to Converse messages.
// Consecutive user-side messages (user turns and tool results) merge, as
// Converse requires alternating roles. Images and documents map to image and
// document blocks; Converse takes no audio, so audio parts are dropped (an
// audio-only turn becomes "[audio message]").
func ToBedrockMessages(msgs []scenario.Message) []types.Message {
	out := make([]types.Message, 0, len(msgs))
	add := func(role types.ConversationRole, blocks []types.ContentBlock) {
		if len(blocks) == 0 {
			return
		}
		if n := len(out); n > 0 && out[n-1].Role == role {
			out[n-1].Content = append(out[n-1].Content, blocks...)
			return
		}
		out = append(out, types.Message{Role: role, Content: blocks})
	}
	for _, m := range msgs {
		switch m.Role {
		case scenario.RoleUser:
			add(types.ConversationRoleUser, contentBlocks(m))
		case scenario.RoleTool:
			text := m.Text()
			if strings.TrimSpace(text) == "" {
				// Converse rejects blank text, and a result needs content.
				text = emptyToolResult
			}
			result := types.ToolResultBlock{
				ToolUseId: aws.String(m.ToolCallID),
				Content:   []types.ToolResultContentBlock{&types.ToolResultContentBlockMemberText{Value: text}},
			}
			if m.IsError {
				result.Status = types.ToolResultStatusError
			}
			add(types.ConversationRoleUser, []types.ContentBlock{&types.ContentBlockMemberToolResult{Value: result}})
		case scenario.RoleAssistant:
			blocks := contentBlocks(m)
			for _, tc := range m.ToolCalls {
				blocks = append(blocks, &types.ContentBlockMemberToolUse{Value: types.ToolUseBlock{
					ToolUseId: aws.String(tc.ID),
					Name:      aws.String(tc.Name),
					Input:     document.NewLazyDocument(argsMap(tc.Arguments)),
				}})
			}
			add(types.ConversationRoleAssistant, blocks)
		}
	}
	return out
}

func contentBlocks(m scenario.Message) []types.ContentBlock {
	if len(m.Parts) == 0 {
		if m.Content == "" {
			return nil
		}
		return []types.ContentBlock{&types.ContentBlockMemberText{Value: m.Content}}
	}
	var blocks []types.ContentBlock
	audioOnly := true
	for _, p := range m.Parts {
		switch {
		case p.Type == scenario.PartText:
			audioOnly = false
			if p.Text != "" {
				blocks = append(blocks, &types.ContentBlockMemberText{Value: p.Text})
			}
		case p.Type == scenario.PartImage && len(p.Data) > 0:
			audioOnly = false
			blocks = append(blocks, &types.ContentBlockMemberImage{Value: types.ImageBlock{
				Format: imageFormat(p),
				Source: &types.ImageSourceMemberBytes{Value: p.Data},
			}})
		case p.Type == scenario.PartFile && !p.IsAudio() && len(p.Data) > 0:
			audioOnly = false
			format := documentFormat(p)
			blocks = append(blocks, &types.ContentBlockMemberDocument{Value: types.DocumentBlock{
				Format: format,
				Name:   aws.String(documentName(p.Filename, format)),
				Source: &types.DocumentSourceMemberBytes{Value: p.Data},
			}})
		case !p.IsAudio():
			audioOnly = false
		}
	}
	if len(blocks) == 0 && audioOnly {
		blocks = append(blocks, &types.ContentBlockMemberText{Value: "[audio message]"})
	}
	return blocks
}

// emptyToolResult stands in for a tool result without output.
const emptyToolResult = "[no output]"

// imageFormats and documentFormats map media types to Converse formats.
var (
	imageFormats = map[string]types.ImageFormat{
		"image/png":  types.ImageFormatPng,
		"image/jpeg": types.ImageFormatJpeg,
		"image/jpg":  types.ImageFormatJpeg,
		"image/gif":  types.ImageFormatGif,
		"image/webp": types.ImageFormatWebp,
	}
	documentFormats = map[string]types.DocumentFormat{
		"application/pdf":    types.DocumentFormatPdf,
		"text/csv":           types.DocumentFormatCsv,
		"application/msword": types.DocumentFormatDoc,
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document": types.DocumentFormatDocx,
		"application/vnd.ms-excel": types.DocumentFormatXls,
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": types.DocumentFormatXlsx,
		"text/html":       types.DocumentFormatHtml,
		"text/plain":      types.DocumentFormatTxt,
		"text/markdown":   types.DocumentFormatMd,
		"text/x-markdown": types.DocumentFormatMd,
	}
)

// mediaType is the bare, lower-case media type ("Text/Plain; charset=utf-8"
// → "text/plain").
func mediaType(mt string) string {
	mt, _, _ = strings.Cut(mt, ";")
	return strings.ToLower(strings.TrimSpace(mt))
}

// imageFormat is the Converse format of an image, sniffed from its bytes
// when the media type is missing; an unknown type passes through as its
// subtype, for Converse to reject by name.
func imageFormat(p scenario.Part) types.ImageFormat {
	mt := mediaType(p.MediaType)
	if mt == "" {
		mt = mediaType(http.DetectContentType(p.Data))
	}
	if f, ok := imageFormats[mt]; ok {
		return f
	}
	_, sub, _ := strings.Cut(mt, "/")
	return types.ImageFormat(sub)
}

// documentFormat is the Converse format of a document: from its media type,
// else from its file extension, else txt for any text; an unknown type
// passes through as its subtype, for Converse to reject by name.
func documentFormat(p scenario.Part) types.DocumentFormat {
	mt := mediaType(p.MediaType)
	if f, ok := documentFormats[mt]; ok {
		return f
	}
	ext := strings.ToLower(strings.TrimPrefix(path.Ext(p.Filename), "."))
	for _, f := range types.DocumentFormat("").Values() {
		if ext != "" && string(f) == ext {
			return f
		}
	}
	if ext == "markdown" {
		return types.DocumentFormatMd
	}
	if strings.HasPrefix(mt, "text/") {
		return types.DocumentFormatTxt
	}
	_, sub, _ := strings.Cut(mt, "/")
	return types.DocumentFormat(sub)
}

// documentName makes a file name fit Converse, which allows only letters,
// digits, single spaces, hyphens, parentheses and square brackets: the
// extension of the format goes, other characters become spaces
// ("my_report.v2.pdf" → "my report v2").
func documentName(filename string, format types.DocumentFormat) string {
	if ext := path.Ext(filename); ext != "" && (strings.EqualFold(ext[1:], string(format)) || documentFormats[mediaType(mime.TypeByExtension(ext))] == format) {
		filename = strings.TrimSuffix(filename, ext)
	}
	var b strings.Builder
	space := false
	for _, r := range filename {
		ok := r < unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r)) || strings.ContainsRune("-()[]", r)
		if !ok {
			space = b.Len() > 0
			continue
		}
		if space {
			b.WriteByte(' ')
			space = false
		}
		b.WriteRune(r)
	}
	if b.Len() == 0 {
		return "document"
	}
	return b.String()
}

// hasToolBlocks reports whether a history holds tool calls or results.
func hasToolBlocks(msgs []scenario.Message) bool {
	for _, m := range msgs {
		if m.Role == scenario.RoleTool || len(m.ToolCalls) > 0 {
			return true
		}
	}
	return false
}

func argsMap(args string) map[string]any {
	var v map[string]any
	if args == "" || json.Unmarshal([]byte(args), &v) != nil || v == nil {
		return map[string]any{}
	}
	return v
}

func fromBedrockMessage(msg types.Message) scenario.Message {
	out := scenario.Message{Role: scenario.RoleAssistant}
	var texts []string
	for _, block := range msg.Content {
		switch b := block.(type) {
		case *types.ContentBlockMemberText:
			texts = append(texts, b.Value)
		case *types.ContentBlockMemberToolUse:
			args := "{}"
			// MarshalSmithyDocument yields the JSON as sent; decoding into
			// any would turn numbers into strings.
			if b.Value.Input != nil {
				if enc, err := b.Value.Input.MarshalSmithyDocument(); err == nil && len(enc) > 0 {
					args = string(enc)
				}
			}
			out.ToolCalls = append(out.ToolCalls, scenario.ToolCall{ID: aws.ToString(b.Value.ToolUseId), Name: aws.ToString(b.Value.Name), Arguments: args})
		}
	}
	out.Content = strings.Join(texts, "\n")
	return out
}

func toInferenceConfig(temperature *float64, maxTokens *int64) *types.InferenceConfiguration {
	if temperature == nil && maxTokens == nil {
		return nil
	}
	cfg := &types.InferenceConfiguration{}
	if temperature != nil {
		cfg.Temperature = aws.Float32(float32(*temperature))
	}
	if maxTokens != nil {
		cfg.MaxTokens = aws.Int32(int32(*maxTokens))
	}
	return cfg
}

// toToolConfig normalizes each schema through JSON first: smithy documents
// cannot encode pre-encoded JSON values the core uses for ordered schemas.
func toToolConfig(tools []scenario.ToolDefinition, choice *scenario.ToolChoice) (*types.ToolConfiguration, error) {
	cfg := &types.ToolConfiguration{}
	for _, t := range tools {
		raw, err := json.Marshal(t.Parameters)
		if err != nil {
			return nil, err
		}
		var schema any
		if err := json.Unmarshal(raw, &schema); err != nil {
			return nil, err
		}
		spec := types.ToolSpecification{
			Name:        aws.String(t.Name),
			InputSchema: &types.ToolInputSchemaMemberJson{Value: document.NewLazyDocument(schema)},
		}
		if t.Description != "" {
			spec.Description = aws.String(t.Description)
		}
		cfg.Tools = append(cfg.Tools, &types.ToolMemberToolSpec{Value: spec})
	}
	if choice != nil {
		switch choice.Type {
		case scenario.ToolChoiceAuto:
			cfg.ToolChoice = &types.ToolChoiceMemberAuto{Value: types.AutoToolChoice{}}
		case scenario.ToolChoiceRequired:
			cfg.ToolChoice = &types.ToolChoiceMemberAny{Value: types.AnyToolChoice{}}
		case scenario.ToolChoiceTool:
			cfg.ToolChoice = &types.ToolChoiceMemberTool{Value: types.SpecificToolChoice{Name: aws.String(choice.ToolName)}}
		}
	}
	return cfg, nil
}
