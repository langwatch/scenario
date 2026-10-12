package gemini

import (
	"encoding/json"
	"strconv"
	"strings"

	scenario "github.com/langwatch/scenario/go"
	"google.golang.org/genai"
)

func splitSystem(msgs []scenario.Message) (*genai.Content, []scenario.Message) {
	var parts []*genai.Part
	rest := make([]scenario.Message, 0, len(msgs))
	for _, m := range msgs {
		if m.Role == scenario.RoleSystem {
			parts = append(parts, genai.NewPartFromText(m.Text()))
			continue
		}
		rest = append(rest, m)
	}
	if len(parts) == 0 {
		return nil, rest
	}
	return &genai.Content{Role: genai.RoleUser, Parts: parts}, rest
}

// ToGeminiContents converts scenario messages to Gemini contents. Text,
// inline images, audio (raw PCM16 wrapped in WAV) and files become parts;
// tool results answer the function by name, resolved from the call id
// (tool results built with scenario.ToolMsg carry no name).
func ToGeminiContents(msgs []scenario.Message) []*genai.Content {
	names := toolNamesByCallID(msgs)
	out := make([]*genai.Content, 0, len(msgs))
	add := func(role genai.Role, parts []*genai.Part) {
		if len(parts) == 0 {
			return
		}
		if n := len(out); n > 0 && out[n-1].Role == string(role) {
			out[n-1].Parts = append(out[n-1].Parts, parts...)
			return
		}
		out = append(out, &genai.Content{Role: string(role), Parts: parts})
	}
	for _, m := range msgs {
		switch m.Role {
		case scenario.RoleUser:
			add(genai.RoleUser, contentParts(m))
		case scenario.RoleAssistant:
			parts := contentParts(m)
			for _, tc := range m.ToolCalls {
				part := genai.NewPartFromFunctionCall(tc.Name, argsMap(tc.Arguments))
				part.FunctionCall.ID = tc.ID
				parts = append(parts, part)
			}
			add(genai.RoleModel, parts)
		case scenario.RoleTool:
			part := genai.NewPartFromFunctionResponse(resultToolName(m, names), responseMap(m.Text(), m.IsError))
			part.FunctionResponse.ID = m.ToolCallID
			add(genai.RoleUser, []*genai.Part{part})
		}
	}
	return out
}

func contentParts(m scenario.Message) []*genai.Part {
	if len(m.Parts) == 0 {
		if m.Content == "" {
			return nil
		}
		return []*genai.Part{genai.NewPartFromText(m.Content)}
	}
	parts := make([]*genai.Part, 0, len(m.Parts))
	for _, p := range m.Parts {
		switch {
		case p.Type == scenario.PartText:
			parts = append(parts, genai.NewPartFromText(p.Text))
		case p.URL != "":
			parts = append(parts, genai.NewPartFromURI(p.URL, p.MediaType))
		case p.MediaType == scenario.MediaTypePCM16:
			parts = append(parts, genai.NewPartFromBytes(scenario.WAVFromPCM16(p.Data), "audio/wav"))
		case len(p.Data) > 0:
			parts = append(parts, genai.NewPartFromBytes(p.Data, p.MediaType))
		}
	}
	return parts
}

func argsMap(args string) map[string]any {
	var v map[string]any
	if args == "" || json.Unmarshal([]byte(args), &v) != nil || v == nil {
		return map[string]any{}
	}
	return v
}

// responseMap is the function response of a tool result: its JSON object,
// or the text under "result"; a failed call goes under "error".
func responseMap(content string, isError bool) map[string]any {
	var v map[string]any
	parsed := json.Unmarshal([]byte(content), &v) == nil && v != nil
	if isError {
		// Gemini reads a failed call from the "error" key of the response.
		if parsed {
			return map[string]any{"error": v}
		}
		return map[string]any{"error": content}
	}
	if parsed {
		return v
	}
	return map[string]any{"result": content}
}

// fromGeminiCandidate converts a candidate. Calls without an id get one from
// their name and position, so parallel calls of one tool stay distinct.
func fromGeminiCandidate(c *genai.Candidate) scenario.Message {
	out := scenario.Message{Role: scenario.RoleAssistant}
	if c.Content == nil {
		return out
	}
	var texts []string
	for i, part := range c.Content.Parts {
		if part.Text != "" && !part.Thought {
			texts = append(texts, part.Text)
		}
		if fc := part.FunctionCall; fc != nil {
			id := fc.ID
			if id == "" {
				id = fc.Name + "_" + strconv.Itoa(i)
			}
			out.ToolCalls = append(out.ToolCalls, scenario.ToolCall{ID: id, Name: fc.Name, Arguments: argsJSON(fc.Args)})
		}
	}
	out.Content = strings.Join(texts, "\n")
	return out
}

// toGeminiTools passes each tool's JSON Schema as is, so property order and
// keywords such as enum and additionalProperties survive.
func toGeminiTools(tools []scenario.ToolDefinition) []*genai.Tool {
	decls := make([]*genai.FunctionDeclaration, 0, len(tools))
	for _, t := range tools {
		decls = append(decls, &genai.FunctionDeclaration{
			Name:                 t.Name,
			Description:          t.Description,
			ParametersJsonSchema: t.Parameters,
		})
	}
	return []*genai.Tool{{FunctionDeclarations: decls}}
}

func toGeminiToolConfig(tc *scenario.ToolChoice) *genai.ToolConfig {
	fc := &genai.FunctionCallingConfig{}
	switch tc.Type {
	case scenario.ToolChoiceAuto:
		fc.Mode = genai.FunctionCallingConfigModeAuto
	case scenario.ToolChoiceRequired:
		fc.Mode = genai.FunctionCallingConfigModeAny
	case scenario.ToolChoiceNone:
		fc.Mode = genai.FunctionCallingConfigModeNone
	case scenario.ToolChoiceTool:
		fc.Mode = genai.FunctionCallingConfigModeAny
		fc.AllowedFunctionNames = []string{tc.ToolName}
	}
	return &genai.ToolConfig{FunctionCallingConfig: fc}
}

// argsJSON encodes function call arguments, "{}" when there are none.
func argsJSON(args map[string]any) string {
	enc, err := json.Marshal(args)
	if err != nil || args == nil {
		return "{}"
	}
	return string(enc)
}

// unknownToolName names a tool result whose call is not in the history,
// since Gemini rejects a function response without a name.
const unknownToolName = "unknown_tool"

// toolNamesByCallID maps the id of every assistant tool call to its name.
func toolNamesByCallID(msgs []scenario.Message) map[string]string {
	names := map[string]string{}
	for _, m := range msgs {
		for _, tc := range m.ToolCalls {
			if tc.ID != "" && tc.Name != "" {
				names[tc.ID] = tc.Name
			}
		}
	}
	return names
}

// resultToolName is the function a tool result answers: its own ToolName,
// else the name of the call with its ToolCallID.
func resultToolName(m scenario.Message, names map[string]string) string {
	if m.ToolName != "" {
		return m.ToolName
	}
	if name := names[m.ToolCallID]; name != "" {
		return name
	}
	return unknownToolName
}
