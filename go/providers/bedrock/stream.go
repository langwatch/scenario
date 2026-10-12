package bedrock

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/document"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
	scenario "github.com/langwatch/scenario/go"
)

// StreamResult is the accumulated answer of a ConverseStream call.
type StreamResult struct {
	// Message is the assistant message, as Converse would return it.
	Message types.Message
	// StopReason is why the model stopped.
	StopReason types.StopReason
	// Usage is the token usage of the call, when Bedrock reported it.
	Usage *types.TokenUsage
}

// StreamConverse runs input as a ConverseStream call for an agent under
// test. Text deltas and tool use start, input and end progress go to stream
// (AgentInput.Stream; nil when granular events are off, which only skips
// the forwarding), and the accumulated message is returned as the
// authoritative answer. Text blocks after the first are preceded by a "\n"
// delta, matching how Provider joins them.
func StreamConverse(ctx context.Context, client *bedrockruntime.Client, input *bedrockruntime.ConverseStreamInput, stream *scenario.MessageStream) (*StreamResult, error) {
	acc, err := streamConverse(ctx, client, input, stream)
	if err != nil {
		return nil, err
	}
	return acc.result(), nil
}

// Stream is Inference with streaming: it forwards progress to stream as
// StreamConverse does and returns the final message.
func (p *Provider) Stream(ctx context.Context, params scenario.InferenceParams, stream *scenario.MessageStream) (*scenario.InferenceResult, error) {
	return p.stream(ctx, params, stream)
}

func (p *Provider) stream(ctx context.Context, params scenario.InferenceParams, stream progress) (*scenario.InferenceResult, error) {
	req, err := toRequest(params)
	if err != nil {
		return nil, err
	}
	acc, err := streamConverse(ctx, p.Client, req, stream)
	if err != nil {
		return nil, err
	}
	return &scenario.InferenceResult{Message: acc.message(), Usage: usageOf(acc.usage)}, nil
}

// progress is the part of *scenario.MessageStream the forwarding uses; its
// methods are no-ops on a nil stream.
type progress interface {
	TextDelta(delta string)
	ToolCallStart(toolCallID, toolName string)
	ToolCallArgs(toolCallID, delta string)
	ToolCallEnd(toolCallID string)
}

func streamConverse(ctx context.Context, client *bedrockruntime.Client, input *bedrockruntime.ConverseStreamInput, stream progress) (*accumulator, error) {
	out, err := client.ConverseStream(ctx, input)
	if err != nil {
		return nil, err
	}
	es := out.GetStream()
	defer es.Close()
	acc := newAccumulator(stream)
	for ev := range es.Events() {
		acc.add(ev)
	}
	if err := es.Err(); err != nil {
		return nil, err
	}
	if len(acc.blocks) == 0 && acc.stopReason == "" {
		return nil, errors.New("empty stream from Bedrock")
	}
	return acc, nil
}

// block is one content block being streamed.
type block struct {
	text     strings.Builder
	toolID   string
	toolName string
	args     strings.Builder
	isTool   bool
}

// accumulator merges ConverseStream events into one message and forwards
// them as progress.
type accumulator struct {
	stream     progress
	blocks     []*block
	byIndex    map[int32]*block
	usage      *types.TokenUsage
	stopReason types.StopReason
}

func newAccumulator(stream progress) *accumulator {
	return &accumulator{stream: stream, byIndex: map[int32]*block{}}
}

// blockAt returns the block of a content index, creating a text block for
// an index first seen in a delta (Bedrock sends no start for text).
func (a *accumulator) blockAt(index *int32) *block {
	i := aws.ToInt32(index)
	if b, ok := a.byIndex[i]; ok {
		return b
	}
	b := &block{}
	a.byIndex[i] = b
	a.blocks = append(a.blocks, b)
	return b
}

func (a *accumulator) hasText() bool {
	for _, b := range a.blocks {
		if !b.isTool && b.text.Len() > 0 {
			return true
		}
	}
	return false
}

func (a *accumulator) add(ev types.ConverseStreamOutput) {
	switch e := ev.(type) {
	case *types.ConverseStreamOutputMemberContentBlockStart:
		if tu, ok := e.Value.Start.(*types.ContentBlockStartMemberToolUse); ok {
			b := a.blockAt(e.Value.ContentBlockIndex)
			b.isTool, b.toolID, b.toolName = true, aws.ToString(tu.Value.ToolUseId), aws.ToString(tu.Value.Name)
			a.stream.ToolCallStart(b.toolID, b.toolName)
		}
	case *types.ConverseStreamOutputMemberContentBlockDelta:
		switch d := e.Value.Delta.(type) {
		case *types.ContentBlockDeltaMemberText:
			if d.Value == "" {
				return
			}
			_, known := a.byIndex[aws.ToInt32(e.Value.ContentBlockIndex)]
			if !known && a.hasText() {
				a.stream.TextDelta("\n")
			}
			b := a.blockAt(e.Value.ContentBlockIndex)
			b.text.WriteString(d.Value)
			a.stream.TextDelta(d.Value)
		case *types.ContentBlockDeltaMemberToolUse:
			b := a.blockAt(e.Value.ContentBlockIndex)
			if in := aws.ToString(d.Value.Input); in != "" && b.isTool {
				b.args.WriteString(in)
				a.stream.ToolCallArgs(b.toolID, in)
			}
		}
	case *types.ConverseStreamOutputMemberContentBlockStop:
		if b, ok := a.byIndex[aws.ToInt32(e.Value.ContentBlockIndex)]; ok && b.isTool {
			a.stream.ToolCallEnd(b.toolID)
		}
	case *types.ConverseStreamOutputMemberMessageStop:
		a.stopReason = e.Value.StopReason
	case *types.ConverseStreamOutputMemberMetadata:
		a.usage = e.Value.Usage
	}
}

func (b *block) arguments() string {
	if s := strings.TrimSpace(b.args.String()); s != "" {
		return s
	}
	return "{}"
}

// message converts the accumulated blocks to a scenario message, keeping
// the tool arguments exactly as streamed.
func (a *accumulator) message() scenario.Message {
	out := scenario.Message{Role: scenario.RoleAssistant}
	var texts []string
	for _, b := range a.blocks {
		if b.isTool {
			out.ToolCalls = append(out.ToolCalls, scenario.ToolCall{ID: b.toolID, Name: b.toolName, Arguments: b.arguments()})
		} else if b.text.Len() > 0 {
			texts = append(texts, b.text.String())
		}
	}
	out.Content = strings.Join(texts, "\n")
	return out
}

// result converts the accumulated blocks to a Bedrock message.
func (a *accumulator) result() *StreamResult {
	msg := types.Message{Role: types.ConversationRoleAssistant}
	for _, b := range a.blocks {
		if !b.isTool {
			if b.text.Len() > 0 {
				msg.Content = append(msg.Content, &types.ContentBlockMemberText{Value: b.text.String()})
			}
			continue
		}
		// Smithy documents encode Go values, not raw JSON; json.Number would
		// encode as a string, so numbers decode as float64.
		var input any
		if err := json.Unmarshal([]byte(b.arguments()), &input); err != nil {
			input = map[string]any{}
		}
		msg.Content = append(msg.Content, &types.ContentBlockMemberToolUse{Value: types.ToolUseBlock{
			ToolUseId: aws.String(b.toolID), Name: aws.String(b.toolName), Input: document.NewLazyDocument(input),
		}})
	}
	return &StreamResult{Message: msg, StopReason: a.stopReason, Usage: a.usage}
}
