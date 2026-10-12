package claudecode

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"testing/iotest"

	scenario "github.com/langwatch/scenario/go"
)

func parse(t *testing.T, stdout string) *Transcript {
	t.Helper()
	tr, err := ParseStreamJSON(strings.NewReader(stdout), Limits{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return tr
}

// inner wraps inner messages as stream-json lines, the way the CLI writes
// them.
func inner(t *testing.T, messages ...string) string {
	t.Helper()
	var out []string
	for _, m := range messages {
		var probe struct {
			Role string `json:"role"`
		}
		if err := json.Unmarshal([]byte(m), &probe); err != nil {
			t.Fatal(err)
		}
		out = append(out, `{"type":"`+probe.Role+`","message":`+m+`}`)
	}
	return strings.Join(out, "\n")
}

func TestArrayToolResultContentIsRenderedReadably(t *testing.T) {
	tr := parse(t, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Here is the answer"}]}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":[{"type":"text","text":"FILE_CONTENTS_MARKER"},{"type":"text","text":"line two"},{"type":"image","source":{}}]}]}}`)
	want := "Here is the answer\n\nTool Result: FILE_CONTENTS_MARKER\nline two\n" + `{"type":"image","source":{}}`
	if tr.Text != want {
		t.Fatalf("text = %q, want %q", tr.Text, want)
	}
}

func TestObjectToolResultContentIsRenderedAsJSON(t *testing.T) {
	tr := parse(t, `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":{"stdout":"OBJECT_RESULT","n":1.50}}]}}`)
	if tr.Text != `Tool Result: {"stdout":"OBJECT_RESULT","n":1.5}` {
		t.Fatalf("text = %q", tr.Text)
	}
}

func TestSessionIDIsTheLastOneSeen(t *testing.T) {
	tr := parse(t, lines(
		`{"type":"system","subtype":"init","session_id":"sess-xyz"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}`,
	))
	if tr.SessionID != "sess-xyz" || tr.Text != "hi" {
		t.Fatalf("%+v", tr)
	}
	tr = parse(t, `{"type":"system","subtype":"init","session_id":"sess-old"}`+"\n"+`{"type":"result","session_id":"sess-new"}`)
	if tr.SessionID != "sess-new" {
		t.Fatalf("session = %q", tr.SessionID)
	}
	tr = parse(t, `{"type":"system","session_id":"sess-a"}`+"\n"+`{"type":"result","session_id":""}`)
	if tr.SessionID != "sess-a" {
		t.Fatalf("an empty id must not overwrite a real one: %q", tr.SessionID)
	}
	if parse(t, `{"type":"assistant"}`).SessionID != "" {
		t.Fatal("no line carries a session id")
	}
}

func TestTheResultEnvelopeIsReadStructurally(t *testing.T) {
	tr := parse(t, `{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["No conversation found",5,{"x":1},"second"]}`)
	want := ResultEnvelope{IsError: true, Subtype: "error_during_execution", Errors: []string{"No conversation found", "second"}}
	if !reflect.DeepEqual(tr.Result, want) {
		t.Fatalf("result = %+v", tr.Result)
	}
	tr = parse(t, `{"type":"result","subtype":"success","is_error":"yes"}`)
	if tr.Result.IsError || tr.Result.Subtype != "success" || tr.Result.Errors != nil {
		t.Fatalf("a non-boolean is_error is not an error: %+v", tr.Result)
	}
	if !reflect.DeepEqual(parse(t, `{"type":"assistant"}`).Result, ResultEnvelope{}) {
		t.Fatal("no result line, zero envelope")
	}
}

func TestStreamEventIsKnownAndUnknownTypesWarnOncePerParse(t *testing.T) {
	logs := &logRecorder{}
	stdout := lines(
		`{"type":"stream_event","event":{"delta":"a"}}`,
		`{"type":"stream_event","event":{"delta":"b"}}`,
		`{"type":"rate_limit_event"}`,
		`{"type":"mystery_event","n":1}`,
		`{"type":"mystery_event","n":2}`,
		`{"type":"mystery_event","n":3}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}`,
	)
	tr, err := ParseStreamJSON(strings.NewReader(stdout), Limits{}, logs.logger())
	if err != nil || tr.Text != "hi" {
		t.Fatalf("%v %q", err, tr.Text)
	}
	if logs.count("stream_event") != 0 || logs.count("rate_limit_event") != 0 || logs.count("mystery_event") != 1 {
		t.Fatalf("warnings = %q", logs.all())
	}
}

func TestMalformedLinesAreSkipped(t *testing.T) {
	tr := parse(t, "not json at all\n{\"type\":\"assistant\",\"message\"\n\r\n  \n[1,2]\n\"str\"\n"+
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}`+"\r\n")
	if tr.Text != "ok" || len(tr.Messages) != 1 {
		t.Fatalf("%+v", tr)
	}
}

func TestAMistypedFieldDoesNotDropItsLine(t *testing.T) {
	tr := parse(t, `{"type":"assistant","session_id":5,"message":{"role":"assistant","content":[{"type":"text","text":"kept","id":7}]}}`)
	if tr.Text != "kept" {
		t.Fatalf("text = %q", tr.Text)
	}
}

func TestLinesSplitAcrossReadsAreReassembled(t *testing.T) {
	big := strings.Repeat("é", 70_000) // longer than the initial line buffer
	stdout := lines(assistantJSON("first"), assistantJSON(big), assistantJSON("last"))
	tr, err := ParseStreamJSON(iotest.HalfReader(strings.NewReader(stdout)), Limits{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if tr.Text != "first\n\n"+big+"\n\nlast" {
		t.Fatalf("text has %d bytes", len(tr.Text))
	}
	tr, _ = ParseStreamJSON(iotest.OneByteReader(strings.NewReader(assistantJSON("no newline"))), Limits{}, nil)
	if tr.Text != "no newline" {
		t.Fatalf("text = %q", tr.Text)
	}
}

func assistantJSON(text string) string {
	b, _ := json.Marshal(map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": text}}}})
	return string(b)
}

func TestStringContentAndOtherRoles(t *testing.T) {
	tr := parse(t, lines(
		`{"type":"user","message":{"role":"user","content":"a plain user line"}}`,
		`{"type":"system","message":{"role":"system","content":"system text"}}`,
		`{"type":"assistant","message":{"role":"assistant","content":"escaped \"text\"\n"}}`,
		`{"type":"assistant","message":{"role":"assistant","content":{"odd":true}}}`,
		`{"type":"assistant","message":"not an object"}`,
	))
	if tr.Text != "a plain user line\n\nsystem text\n\nescaped \"text\"\n" {
		t.Fatalf("text = %q", tr.Text)
	}
	want := []scenario.Message{
		{Role: scenario.RoleUser, Content: "a plain user line"},
		{Role: scenario.RoleAssistant, Content: "escaped \"text\"\n"},
	}
	if !reflect.DeepEqual(tr.Messages, want) {
		t.Fatalf("messages = %+v", tr.Messages)
	}
}

// --- conversion to messages --------------------------------------------------

var skillTranscript = []string{
	`{"role":"assistant","content":[{"type":"thinking","thinking":"Read the skill first.","signature":"s"},{"type":"text","text":"I'll start by reading the skill instructions."},{"type":"tool_use","id":"toolu_01","name":"Bash","input":{"command":"cat .skills/scenarios/SKILL.md"}}]}`,
	`{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":[{"type":"text","text":"# Scenarios skill"}]}]}`,
	`{"role":"assistant","content":[{"type":"text","text":"Done."}]}`,
}

func TestToolCallsAndResultsBecomeMessagesAndThinkingIsDropped(t *testing.T) {
	tr := parse(t, inner(t, skillTranscript...))
	want := []scenario.Message{
		{Role: scenario.RoleAssistant, Parts: []scenario.Part{scenario.TextPart("I'll start by reading the skill instructions.")},
			ToolCalls: []scenario.ToolCall{{ID: "toolu_01", Name: "Bash", Arguments: `{"command":"cat .skills/scenarios/SKILL.md"}`}}},
		{Role: scenario.RoleTool, ToolCallID: "toolu_01", ToolName: "Bash", Content: "# Scenarios skill"},
		{Role: scenario.RoleAssistant, Parts: []scenario.Part{scenario.TextPart("Done.")}},
	}
	if !reflect.DeepEqual(tr.Messages, want) {
		t.Fatalf("messages:\n got %+v\nwant %+v", tr.Messages, want)
	}
	if strings.Contains(tr.Text, "Read the skill first.") {
		t.Fatal("thinking must be dropped from the text")
	}
	wantText := "I'll start by reading the skill instructions.\nTool Called: Bash({\"command\":\"cat .skills/scenarios/SKILL.md\"})\n\nTool Result: # Scenarios skill\n\nDone."
	if tr.Text != wantText {
		t.Fatalf("text = %q", tr.Text)
	}
}

func TestAToolOnlyTurnKeepsAnEmptyTextPart(t *testing.T) {
	tr := parse(t, inner(t, `{"role":"assistant","content":[{"type":"tool_use","id":"toolu_02","name":"Read","input":{"file":"x"}}]}`))
	want := scenario.Message{Role: scenario.RoleAssistant, Parts: []scenario.Part{scenario.TextPart("")},
		ToolCalls: []scenario.ToolCall{{ID: "toolu_02", Name: "Read", Arguments: `{"file":"x"}`}}}
	if len(tr.Messages) != 1 || !reflect.DeepEqual(tr.Messages[0], want) {
		t.Fatalf("messages = %+v", tr.Messages)
	}
}

func TestABlockWithNoPartLeavesALineNamingIt(t *testing.T) {
	tr := parse(t, inner(t,
		`{"role":"assistant","content":[{"type":"text","text":"Here is the screenshot."},{"type":"image","source":{"type":"base64","data":"iVBORw0KGgo="}}]}`,
		`{"role":"user","content":[{"type":"document","source":{"type":"text","data":"x"}},{"source":{}}]}`,
	))
	want := []scenario.Message{
		{Role: scenario.RoleAssistant, Parts: []scenario.Part{scenario.TextPart("Here is the screenshot.\n[image block, not shown in the transcript]")}},
		{Role: scenario.RoleUser, Content: "[document block, not shown in the transcript]\n[unknown block, not shown in the transcript]"},
	}
	if !reflect.DeepEqual(tr.Messages, want) {
		t.Fatalf("messages = %+v", tr.Messages)
	}
}

func TestAFailedToolResultKeepsItsText(t *testing.T) {
	// Deviation: the core message model has no error flag for tool results,
	// so the JS "error-text" output becomes a plain tool result.
	tr := parse(t, inner(t,
		`{"role":"assistant","content":[{"type":"tool_use","id":"toolu_03","name":"Bash","input":{"command":"false"}}]}`,
		`{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_03","content":"exit 1","is_error":true}]}`,
	))
	want := scenario.Message{Role: scenario.RoleTool, ToolCallID: "toolu_03", ToolName: "Bash", Content: "exit 1"}
	if !reflect.DeepEqual(tr.Messages[1], want) {
		t.Fatalf("message = %+v", tr.Messages[1])
	}
}

func TestAResultOfAnUnknownCallIsNamedTool(t *testing.T) {
	tr := parse(t, inner(t, `{"role":"user","content":[{"type":"tool_result","tool_use_id":"nope","content":"x"}]}`))
	if tr.Messages[0].ToolName != "tool" {
		t.Fatalf("%+v", tr.Messages[0])
	}
}

func TestToolInputEdgeCases(t *testing.T) {
	tr := parse(t, inner(t,
		`{"role":"assistant","content":[{"type":"tool_use","id":"a","name":"X","input":null},{"type":"tool_use","id":"b"},{"type":"tool_use","id":"c","name":"Y","input":{"n":1.0,"s":"é"}}]}`,
	))
	calls := tr.Messages[0].ToolCalls
	want := []scenario.ToolCall{{ID: "a", Name: "X", Arguments: "{}"}, {ID: "b", Name: "tool", Arguments: "{}"}, {ID: "c", Name: "Y", Arguments: `{"n":1,"s":"é"}`}}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls = %+v", calls)
	}
	if tr.Text != "Tool Called: X(null)\nTool Called: unknown()\nTool Called: Y({\"n\":1,\"s\":\"é\"})" {
		t.Fatalf("text = %q", tr.Text)
	}
}

// --- caps ----------------------------------------------------------------

var huge = strings.Repeat("x", 60_000)

func bigTranscript(t *testing.T) string {
	return inner(t,
		`{"role":"assistant","content":[{"type":"tool_use","id":"toolu_big","name":"Bash","input":{"command":"cat > report.html <<EOF\n`+huge+`"}}]}`,
		`{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_big","content":[{"type":"text","text":"`+huge+`"}]}]}`,
	)
}

func TestToolInputsAndResultsAreCapped(t *testing.T) {
	tr := parse(t, bigTranscript(t))
	var input struct{ Command string }
	if err := json.Unmarshal([]byte(tr.Messages[0].ToolCalls[0].Arguments), &input); err != nil {
		t.Fatal(err)
	}
	if len(input.Command) >= 31_000 || !strings.HasPrefix(input.Command, "cat > report.html") || !strings.HasSuffix(input.Command, "\n… [30024 more characters]") {
		t.Fatalf("command has %d bytes, ends %q", len(input.Command), input.Command[len(input.Command)-40:])
	}
	result := tr.Messages[1].Content
	if result != strings.Repeat("x", 8000)+"\n… [52000 more characters]" {
		t.Fatalf("result has %d bytes", len(result))
	}
	if len(tr.Text) >= 40_000 || !strings.Contains(tr.Text, "Tool Called: Bash(") || !strings.Contains(tr.Text, "Tool Result: ") || strings.Count(tr.Text, "more characters") != 2 {
		t.Fatalf("text has %d bytes", len(tr.Text))
	}
}

func TestStringsNestedInAToolInputAreCappedToo(t *testing.T) {
	tr := parse(t, inner(t, `{"role":"assistant","content":[{"type":"tool_use","id":"n","name":"Write","input":{"payload":{"html":"`+huge+`"},"files":["`+huge+`",1,true,null]}}]}`))
	var input struct {
		Payload struct{ HTML string }
		Files   []any
	}
	if err := json.Unmarshal([]byte(tr.Messages[0].ToolCalls[0].Arguments), &input); err != nil {
		t.Fatal(err)
	}
	file, _ := input.Files[0].(string)
	if len(input.Payload.HTML) >= 31_000 || !strings.Contains(input.Payload.HTML, "more characters") || len(file) >= 31_000 || len(input.Files) != 4 {
		t.Fatalf("html %d, file %d, files %v", len(input.Payload.HTML), len(file), input.Files[1:])
	}
}

func TestASmallToolCallIsLeftAlone(t *testing.T) {
	tr := parse(t, inner(t, `{"role":"assistant","content":[{"type":"tool_use","id":"s","name":"Bash","input":{"command":"langwatch virtual-keys list"}}]}`))
	if got := BashCommands(tr.Messages); !reflect.DeepEqual(got, []string{"langwatch virtual-keys list"}) {
		t.Fatalf("commands = %q", got)
	}
}

func TestCapsCountUTF16UnitsLikeJavaScript(t *testing.T) {
	// 😀 is two UTF-16 units; a cap through the middle drops the half.
	if got := truncateText("😀😀😀", 3); got != "😀\n… [3 more characters]" {
		t.Fatalf("got %q", got)
	}
	if got := truncateText("ééé", 3); got != "ééé" {
		t.Fatalf("got %q", got)
	}
}

func TestConfiguredLimitsApply(t *testing.T) {
	tr, _ := ParseStreamJSON(strings.NewReader(inner(t,
		`{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"Bash","input":{"command":"abcdef"}}]}`,
		`{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"0123456789"}]}`,
	)), Limits{MaxToolResultChars: 4, MaxToolInputChars: 3}, nil)
	if tr.Messages[0].ToolCalls[0].Arguments != `{"command":"abc\n… [3 more characters]"}` || tr.Messages[1].Content != "0123\n… [6 more characters]" {
		t.Fatalf("%+v", tr.Messages)
	}
	if !strings.HasPrefix(tr.Text, "Tool Called: Bash({\"c\n… [") {
		t.Fatalf("text = %q", tr.Text)
	}
}
