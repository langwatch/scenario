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
// tool results answer the function by name, resolved from the call id.
func ToGeminiContents(msgs []scenario.Message) []*genai.Content {
	names := map[string]string{}
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
				names[tc.ID] = tc.Name
				part := genai.NewPartFromFunctionCall(tc.Name, argsMap(tc.Arguments))
				part.FunctionCall.ID = tc.ID
				parts = append(parts, part)
			}
			add(genai.RoleModel, parts)
		case scenario.RoleTool:
			name := m.ToolName
			if name == "" {
				name = names[m.ToolCallID]
			}
			part := genai.NewPartFromFunctionResponse(name, responseMap(m.Text()))
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

func responseMap(content string) map[string]any {
	var v map[string]any
	if json.Unmarshal([]byte(content), &v) == nil && v != nil {
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
			args, err := json.Marshal(fc.Args)
			if err != nil || fc.Args == nil {
				args = []byte("{}")
			}
			id := fc.ID
			if id == "" {
				id = fc.Name + "_" + strconv.Itoa(i)
			}
			out.ToolCalls = append(out.ToolCalls, scenario.ToolCall{ID: id, Name: fc.Name, Arguments: string(args)})
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
