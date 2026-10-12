package scenario

import (
	"slices"
	"testing"
)

// A tool result built with ToolMsg carries no ToolName; the simulator still
// names the tool, from the assistant call the result answers, as the JS SDK
// does from the tool-result part.
func TestReverseRolesNamesToolResultFromItsCall(t *testing.T) {
	t.Parallel()
	msgs := []Message{
		{Role: RoleAssistant, ToolCalls: []ToolCall{{ID: "c1", Name: "lookup", Arguments: `{"q":1}`}}},
		ToolMsg("c1", "found"),
		ToolMsg("c2", "orphan"),
	}
	var got []string
	for _, m := range reverseRoles(msgs) {
		got = append(got, string(m.Role)+":"+m.Content)
	}
	want := []string{
		`user:[Called tool lookup with: {"q":1}]`,
		"user:[Tool result from lookup: found]",
		"user:[Tool result from unknown tool: orphan]",
	}
	if !slices.Equal(got, want) {
		t.Errorf("reversed %v, want %v", got, want)
	}
}
