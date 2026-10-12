package redteam

import (
	"encoding/base64"

	scenario "github.com/langwatch/scenario/go"
	"github.com/langwatch/scenario/go/internal/jsjson"
)

// This file encodes messages in the AI SDK ModelMessage shape the JS SDK
// holds them in: {"role":…,"content":…}, content a string for plain text and
// an array of parts otherwise. The report stores messages in this shape, and
// non-text content reaches the attacker as its JSON, like JSON.stringify.

// isPlainText reports whether the message content is a bare string.
func isPlainText(m scenario.Message) bool {
	return m.Role == scenario.RoleSystem || (len(m.Parts) == 0 && len(m.ToolCalls) == 0 && m.Role != scenario.RoleTool)
}

// contentText returns the message content as the JS SDK sees it: the
// string, or the JSON of its parts.
func contentText(m scenario.Message) string {
	if isPlainText(m) {
		return m.Text()
	}
	return string(appendContent(nil, m))
}

func appendMessage(b []byte, m scenario.Message) []byte {
	b = append(b, `{"role":`...)
	b = jsjson.AppendString(b, string(m.Role))
	b = append(b, `,"content":`...)
	b = appendContent(b, m)
	return append(b, '}')
}

func appendContent(b []byte, m scenario.Message) []byte {
	if isPlainText(m) {
		return jsjson.AppendString(b, m.Text())
	}
	b = append(b, '[')
	if m.Role == scenario.RoleTool {
		b = appendToolResult(b, m)
		return append(b, ']')
	}
	n := 0
	sep := func() {
		if n > 0 {
			b = append(b, ',')
		}
		n++
	}
	if len(m.Parts) == 0 && m.Content != "" {
		sep()
		b = appendPart(b, scenario.TextPart(m.Content))
	}
	for _, p := range m.Parts {
		sep()
		b = appendPart(b, p)
	}
	for _, tc := range m.ToolCalls {
		sep()
		b = append(b, `{"type":"tool-call","toolCallId":`...)
		b = jsjson.AppendString(b, tc.ID)
		b = append(b, `,"toolName":`...)
		b = jsjson.AppendString(b, tc.Name)
		b = append(b, `,"input":`...)
		b = appendToolInput(b, tc.Arguments)
		b = append(b, '}')
	}
	return append(b, ']')
}

func appendPart(b []byte, p scenario.Part) []byte {
	switch p.Type {
	case scenario.PartText:
		b = append(b, `{"type":"text","text":`...)
		b = jsjson.AppendString(b, p.Text)
		return append(b, '}')
	case scenario.PartImage:
		b = append(b, `{"type":"image","image":`...)
		b = appendPayload(b, p)
		if p.MediaType != "" {
			b = append(b, `,"mediaType":`...)
			b = jsjson.AppendString(b, p.MediaType)
		}
		return append(b, '}')
	case scenario.PartFile:
		b = append(b, `{"type":"file","mediaType":`...)
		b = jsjson.AppendString(b, p.MediaType)
		b = append(b, `,"data":`...)
		b = appendPayload(b, p)
		if p.Filename != "" {
			b = append(b, `,"filename":`...)
			b = jsjson.AppendString(b, p.Filename)
		}
		return append(b, '}')
	}
	if len(p.Raw) > 0 {
		return append(b, p.Raw...)
	}
	b = append(b, `{"type":`...)
	b = jsjson.AppendString(b, string(p.Type))
	return append(b, '}')
}

// appendPayload writes the URL of a media part, or its data as Base64.
func appendPayload(b []byte, p scenario.Part) []byte {
	if p.URL != "" {
		return jsjson.AppendString(b, p.URL)
	}
	b = append(b, '"')
	b = base64.StdEncoding.AppendEncode(b, p.Data)
	return append(b, '"')
}

// appendToolInput writes tool call arguments as their JSON value, or as a
// string when they are not valid JSON.
func appendToolInput(b []byte, args string) []byte {
	if args == "" {
		return append(b, "{}"...)
	}
	if v, err := jsjson.Parse(args); err == nil {
		return jsjson.Append(b, v)
	}
	return jsjson.AppendString(b, args)
}

func appendToolResult(b []byte, m scenario.Message) []byte {
	b = append(b, `{"type":"tool-result","toolCallId":`...)
	b = jsjson.AppendString(b, m.ToolCallID)
	b = append(b, `,"toolName":`...)
	b = jsjson.AppendString(b, m.ToolName)
	b = append(b, `,"output":`...)
	text := m.Text()
	if jsjson.LooksLikeJSON(text) {
		if v, err := jsjson.Parse(text); err == nil {
			b = append(b, `{"type":"json","value":`...)
			b = jsjson.Append(b, v)
			return append(b, "}}"...)
		}
	}
	b = append(b, `{"type":"text","value":`...)
	b = jsjson.AppendString(b, text)
	return append(b, "}}"...)
}

// lastContent returns the content of the last message of the role that has
// any, as the JS SDK reads it, and its index; "" and -1 when none.
func lastContent(messages []scenario.Message, role scenario.Role) (string, int) {
	for i := len(messages) - 1; i >= 0; i-- {
		m := messages[i]
		if m.Role != role {
			continue
		}
		if isPlainText(m) {
			if m.Content != "" {
				return m.Content, i
			}
			continue
		}
		return contentText(m), i
	}
	return "", -1
}
