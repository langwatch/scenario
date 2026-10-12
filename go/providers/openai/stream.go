package openai

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	scenario "github.com/langwatch/scenario/go"
	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
)

// StreamChatCompletion runs req as a streaming chat completion for an agent
// under test. Text deltas and tool call start, argument and end progress go
// to stream (AgentInput.Stream; nil when granular events are off, which
// only skips the forwarding), and the accumulated completion is returned as
// the authoritative answer. Tool calls a server streams without an id get
// "call_<index>", in the events and in the returned completion alike.
func StreamChatCompletion(ctx context.Context, client *openai.Client, req openai.ChatCompletionNewParams, stream *scenario.MessageStream, opts ...option.RequestOption) (*openai.ChatCompletion, error) {
	return streamChatCompletion(ctx, client, req, stream, opts...)
}

// progress is the part of *scenario.MessageStream the forwarding uses; its
// methods are no-ops on a nil stream.
type progress interface {
	TextDelta(delta string)
	ToolCallStart(toolCallID, toolName string)
	ToolCallArgs(toolCallID, delta string)
	ToolCallEnd(toolCallID string)
}

func streamChatCompletion(ctx context.Context, client *openai.Client, req openai.ChatCompletionNewParams, stream progress, opts ...option.RequestOption) (*openai.ChatCompletion, error) {
	s := client.Chat.Completions.NewStreaming(ctx, req, opts...)
	defer s.Close()
	var acc openai.ChatCompletionAccumulator
	fw := chunkForwarder{stream: stream, ids: map[int64]string{}}
	for s.Next() {
		chunk := s.Current()
		if !acc.AddChunk(chunk) {
			// The accumulator refuses a chunk whose id differs from the
			// first one; some OpenAI-compatible servers change it mid-stream
			// (or send it empty), yet the chunks are one completion.
			chunk.ID = acc.ID
			if !acc.AddChunk(chunk) {
				return nil, fmt.Errorf("openai: could not accumulate stream chunk %q", s.Current().ID)
			}
		}
		fw.forward(chunk)
	}
	if err := s.Err(); err != nil {
		return nil, err
	}
	fw.finish()
	completion := acc.ChatCompletion
	for i := range completion.Choices {
		for j := range completion.Choices[i].Message.ToolCalls {
			tc := &completion.Choices[i].Message.ToolCalls[j]
			if tc.ID == "" {
				tc.ID = fallbackToolCallID(int64(j))
			}
		}
	}
	return &completion, nil
}

// Stream is Inference with streaming: it forwards progress to stream as
// StreamChatCompletion does and returns the final message.
func (p *Provider) Stream(ctx context.Context, params scenario.InferenceParams, stream *scenario.MessageStream) (*scenario.InferenceResult, error) {
	return p.stream(ctx, params, stream)
}

func (p *Provider) stream(ctx context.Context, params scenario.InferenceParams, stream progress) (*scenario.InferenceResult, error) {
	req := p.request(params)
	if !p.LegacyParams {
		req.StreamOptions.IncludeUsage = openai.Bool(true)
	}
	completion, err := streamChatCompletion(ctx, p.Client, req, stream, p.requestOptions(params.Model)...)
	if err != nil {
		return nil, err
	}
	if len(completion.Choices) == 0 {
		return nil, errors.New("no response choices from OpenAI")
	}
	res := &scenario.InferenceResult{Message: fromOpenAIMessage(completion.Choices[0].Message)}
	if u := completion.Usage; u.PromptTokens != 0 || u.CompletionTokens != 0 {
		res.Usage = &scenario.Usage{InputTokens: u.PromptTokens, OutputTokens: u.CompletionTokens}
	}
	return res, nil
}

// chunkForwarder turns the deltas of the first choice into stream events.
// OpenAI streams tool calls one after another, so a call ends when the next
// one starts or the stream ends.
type chunkForwarder struct {
	stream progress
	ids    map[int64]string
	open   []string
}

func (f *chunkForwarder) forward(chunk openai.ChatCompletionChunk) {
	for _, choice := range chunk.Choices {
		if choice.Index != 0 {
			continue
		}
		if choice.Delta.Content != "" {
			f.stream.TextDelta(choice.Delta.Content)
		}
		for _, tc := range choice.Delta.ToolCalls {
			// Some servers send index -1 for a single call; the accumulator
			// reads it as 0, and so does the forwarding.
			index := max(tc.Index, 0)
			id, seen := f.ids[index]
			if !seen {
				id = tc.ID
				if id == "" {
					id = fallbackToolCallID(index)
				}
				f.ids[index] = id
				f.endOpen()
				f.stream.ToolCallStart(id, tc.Function.Name)
				f.open = append(f.open, id)
			}
			if tc.Function.Arguments != "" {
				f.stream.ToolCallArgs(id, tc.Function.Arguments)
			}
		}
	}
}

func (f *chunkForwarder) endOpen() {
	for _, id := range f.open {
		f.stream.ToolCallEnd(id)
	}
	f.open = f.open[:0]
}

func (f *chunkForwarder) finish() { f.endOpen() }

func fallbackToolCallID(index int64) string { return "call_" + strconv.FormatInt(index, 10) }
