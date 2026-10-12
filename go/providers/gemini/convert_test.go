package gemini

import (
	"testing"

	scenario "github.com/langwatch/scenario/go"
)

// Tool results built with scenario.ToolMsg carry no ToolName; Gemini needs
// the function name, so it comes from the matching assistant tool call.
func TestToolResultNameFromCallID(t *testing.T) {
	contents := ToGeminiContents([]scenario.Message{
		scenario.UserMsg("weather and time?"),
		{Role: scenario.RoleAssistant, ToolCalls: []scenario.ToolCall{
			{ID: "c1", Name: "get_weather", Arguments: `{}`},
			{ID: "c2", Name: "get_time", Arguments: `{}`},
		}},
		scenario.ToolMsg("c2", "noon"),
		scenario.ToolMsg("c1", "sunny"),
		{Role: scenario.RoleTool, ToolCallID: "c1", ToolName: "explicit", Content: "x"},
		scenario.ToolMsg("missing", "orphan"),
	})
	var got []string
	for _, c := range contents {
		for _, p := range c.Parts {
			if p.FunctionResponse != nil {
				got = append(got, p.FunctionResponse.ID+"="+p.FunctionResponse.Name)
			}
		}
	}
	want := []string{"c2=get_time", "c1=get_weather", "c1=explicit", "missing=" + unknownToolName}
	if len(got) != len(want) {
		t.Fatalf("function responses %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("response %d = %s, want %s", i, got[i], want[i])
		}
	}
}
