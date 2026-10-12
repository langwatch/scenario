package anthropic

import (
	"context"
	"errors"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
	scenario "github.com/langwatch/scenario/go"
)

// StreamMessage runs req as a streaming Messages API call for an agent
// under test. Text deltas and tool use start, input and end progress go to
// stream (AgentInput.Stream; nil when granular events are off, which only
// skips the forwarding), and the accumulated message is returned as the
// authoritative answer. Text blocks after the first are preceded by a "\n"
// delta, matching how Provider joins them.
func StreamMessage(ctx context.Context, client *anthropic.Client, req anthropic.MessageNewParams, stream *scenario.MessageStream, opts ...option.RequestOption) (*anthropic.Message, error) {
	return streamMessage(ctx, client, req, stream, opts...)
}

// Stream is Inference with streaming: it forwards progress to stream as
// StreamMessage does and returns the final message.
func (p *Provider) Stream(ctx context.Context, params scenario.InferenceParams, stream *scenario.MessageStream) (*scenario.InferenceResult, error) {
	return p.stream(ctx, params, stream)
}

func (p *Provider) stream(ctx context.Context, params scenario.InferenceParams, stream progress) (*scenario.InferenceResult, error) {
	msg, err := streamMessage(ctx, p.Client, toRequest(params), stream)
	if err != nil {
		return nil, err
	}
	return &scenario.InferenceResult{
		Message: fromAnthropicResponse(msg),
		Usage:   &scenario.Usage{InputTokens: msg.Usage.InputTokens, OutputTokens: msg.Usage.OutputTokens},
	}, nil
}

// progress is the part of *scenario.MessageStream the forwarding uses; its
// methods are no-ops on a nil stream.
type progress interface {
	TextDelta(delta string)
	ToolCallStart(toolCallID, toolName string)
	ToolCallArgs(toolCallID, delta string)
	ToolCallEnd(toolCallID string)
}

func streamMessage(ctx context.Context, client *anthropic.Client, req anthropic.MessageNewParams, stream progress, opts ...option.RequestOption) (*anthropic.Message, error) {
	s := client.Messages.NewStreaming(ctx, req, opts...)
	defer s.Close()
	var msg anthropic.Message
	tools := map[int64]string{} // open tool_use blocks by index
	hadText := false
	for s.Next() {
		ev := s.Current()
		if err := msg.Accumulate(ev); err != nil {
			return nil, err
		}
		switch ev.Type {
		case "content_block_start":
			switch ev.ContentBlock.Type {
			case "text":
				if hadText {
					stream.TextDelta("\n")
				}
				hadText = true
				if ev.ContentBlock.Text != "" {
					stream.TextDelta(ev.ContentBlock.Text)
				}
			case "tool_use":
				tools[ev.Index] = ev.ContentBlock.ID
				stream.ToolCallStart(ev.ContentBlock.ID, ev.ContentBlock.Name)
			}
		case "content_block_delta":
			switch ev.Delta.Type {
			case "text_delta":
				if ev.Delta.Text != "" {
					stream.TextDelta(ev.Delta.Text)
				}
			case "input_json_delta":
				if id, ok := tools[ev.Index]; ok && ev.Delta.PartialJSON != "" {
					stream.ToolCallArgs(id, ev.Delta.PartialJSON)
				}
			}
		case "content_block_stop":
			if id, ok := tools[ev.Index]; ok {
				stream.ToolCallEnd(id)
				delete(tools, ev.Index)
			}
		}
	}
	if err := s.Err(); err != nil {
		return nil, err
	}
	if msg.ID == "" && len(msg.Content) == 0 {
		return nil, errors.New("empty stream from Anthropic")
	}
	return &msg, nil
}
