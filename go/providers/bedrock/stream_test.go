package bedrock

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
	scenario "github.com/langwatch/scenario/go"
)

// recorder is a progress sink that records events as "kind:id:payload".
type recorder struct{ events []string }

func (r *recorder) TextDelta(d string)            { r.events = append(r.events, "text:"+d) }
func (r *recorder) ToolCallStart(id, name string) { r.events = append(r.events, "start:"+id+":"+name) }
func (r *recorder) ToolCallArgs(id, d string)     { r.events = append(r.events, "args:"+id+":"+d) }
func (r *recorder) ToolCallEnd(id string)         { r.events = append(r.events, "end:"+id) }

func textDelta(i int32, s string) types.ConverseStreamOutput {
	return &types.ConverseStreamOutputMemberContentBlockDelta{Value: types.ContentBlockDeltaEvent{
		ContentBlockIndex: aws.Int32(i), Delta: &types.ContentBlockDeltaMemberText{Value: s},
	}}
}

func toolDelta(i int32, s string) types.ConverseStreamOutput {
	return &types.ConverseStreamOutputMemberContentBlockDelta{Value: types.ContentBlockDeltaEvent{
		ContentBlockIndex: aws.Int32(i), Delta: &types.ContentBlockDeltaMemberToolUse{Value: types.ToolUseBlockDelta{Input: aws.String(s)}},
	}}
}

// The stream events are fed directly: encoding Bedrock's binary event
// stream in a test server would test the AWS SDK, not the accumulation.
func TestAccumulatorForwardsTextAndToolUse(t *testing.T) {
	rec := &recorder{}
	acc := newAccumulator(rec)
	for _, ev := range []types.ConverseStreamOutput{
		&types.ConverseStreamOutputMemberMessageStart{Value: types.MessageStartEvent{Role: types.ConversationRoleAssistant}},
		textDelta(0, "Let me "),
		textDelta(0, "check."),
		&types.ConverseStreamOutputMemberContentBlockStop{Value: types.ContentBlockStopEvent{ContentBlockIndex: aws.Int32(0)}},
		&types.ConverseStreamOutputMemberContentBlockStart{Value: types.ContentBlockStartEvent{
			ContentBlockIndex: aws.Int32(1),
			Start:             &types.ContentBlockStartMemberToolUse{Value: types.ToolUseBlockStart{ToolUseId: aws.String("tu1"), Name: aws.String("get_weather")}},
		}},
		toolDelta(1, `{"city":`),
		toolDelta(1, `"Paris","days":2}`),
		&types.ConverseStreamOutputMemberContentBlockStop{Value: types.ContentBlockStopEvent{ContentBlockIndex: aws.Int32(1)}},
		textDelta(2, "Done."),
		&types.ConverseStreamOutputMemberMessageStop{Value: types.MessageStopEvent{StopReason: types.StopReasonToolUse}},
		&types.ConverseStreamOutputMemberMetadata{Value: types.ConverseStreamMetadataEvent{Usage: &types.TokenUsage{InputTokens: aws.Int32(3), OutputTokens: aws.Int32(9)}}},
	} {
		acc.add(ev)
	}
	want := []string{"text:Let me ", "text:check.", "start:tu1:get_weather", `args:tu1:{"city":`, `args:tu1:"Paris","days":2}`, "end:tu1", "text:\n", "text:Done."}
	if strings.Join(rec.events, "|") != strings.Join(want, "|") {
		t.Fatalf("events\n got %q\nwant %q", rec.events, want)
	}
	m := acc.message()
	if m.Text() != "Let me check.\nDone." || len(m.ToolCalls) != 1 || m.ToolCalls[0].Arguments != `{"city":"Paris","days":2}` {
		t.Fatalf("message %+v", m)
	}
	if u := usageOf(acc.usage); u == nil || u.OutputTokens != 9 {
		t.Fatalf("usage %+v", u)
	}
	res := acc.result()
	if res.StopReason != types.StopReasonToolUse || len(res.Message.Content) != 3 {
		t.Fatalf("result %+v", res)
	}
	// The native message converts back to equivalent arguments.
	back := fromBedrockMessage(res.Message)
	var args map[string]any
	if err := json.Unmarshal([]byte(back.ToolCalls[0].Arguments), &args); err != nil || args["city"] != "Paris" || args["days"] != float64(2) {
		t.Fatalf("round trip %+v (%v)", back.ToolCalls, err)
	}
}

func TestAccumulatorAcceptsNilStream(t *testing.T) {
	acc := newAccumulator((*scenario.MessageStream)(nil)) // what agents get with granular events off
	acc.add(textDelta(0, "ok"))
	if acc.message().Text() != "ok" {
		t.Fatal(acc.message())
	}
}
