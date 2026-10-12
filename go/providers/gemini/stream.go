package gemini

import (
	"context"
	"errors"
	"strconv"

	scenario "github.com/langwatch/scenario/go"
	"google.golang.org/genai"
)

// StreamGenerateContent runs a streaming generateContent call for an agent
// under test. Text deltas go to stream (AgentInput.Stream; nil when
// granular events are off, which only skips the forwarding); Gemini sends
// each function call whole, so its start, arguments and end are forwarded
// together. The chunks are merged into one response (consecutive text
// joined, function calls kept, usage from the last chunk), returned as the
// authoritative answer. A function call without an id gets "<name>_<part
// index>", in the events and in the response alike, as Provider names it.
func StreamGenerateContent(ctx context.Context, client *genai.Client, model string, contents []*genai.Content, cfg *genai.GenerateContentConfig, stream *scenario.MessageStream) (*genai.GenerateContentResponse, error) {
	return streamGenerateContent(ctx, client, model, contents, cfg, stream)
}

// Stream is Inference with streaming: it forwards progress to stream as
// StreamGenerateContent does and returns the final message.
func (p *Provider) Stream(ctx context.Context, params scenario.InferenceParams, stream *scenario.MessageStream) (*scenario.InferenceResult, error) {
	return p.stream(ctx, params, stream)
}

func (p *Provider) stream(ctx context.Context, params scenario.InferenceParams, stream progress) (*scenario.InferenceResult, error) {
	contents, cfg := toRequest(params, &p.signatures)
	resp, err := streamGenerateContent(ctx, p.Client, params.Model, contents, cfg, stream)
	if err != nil {
		return nil, err
	}
	p.signatures.remember(resp.Candidates[0])
	return &scenario.InferenceResult{Message: fromGeminiCandidate(resp.Candidates[0]), Usage: usageOf(resp.UsageMetadata)}, nil
}

// progress is the part of *scenario.MessageStream the forwarding uses; its
// methods are no-ops on a nil stream.
type progress interface {
	TextDelta(delta string)
	ToolCallStart(toolCallID, toolName string)
	ToolCallArgs(toolCallID, delta string)
	ToolCallEnd(toolCallID string)
}

func streamGenerateContent(ctx context.Context, client *genai.Client, model string, contents []*genai.Content, cfg *genai.GenerateContentConfig, stream progress) (*genai.GenerateContentResponse, error) {
	merged := &genai.GenerateContentResponse{}
	cand := &genai.Candidate{Content: &genai.Content{Role: genai.RoleModel}}
	hadText, lastWasText := false, false
	for chunk, err := range client.Models.GenerateContentStream(ctx, model, contents, cfg) {
		if err != nil {
			return nil, err
		}
		if chunk == nil {
			continue
		}
		if chunk.UsageMetadata != nil {
			merged.UsageMetadata = chunk.UsageMetadata
		}
		merged.ModelVersion, merged.ResponseID = chunk.ModelVersion, chunk.ResponseID
		if len(chunk.Candidates) == 0 || chunk.Candidates[0] == nil {
			continue
		}
		c := chunk.Candidates[0]
		if c.FinishReason != "" {
			cand.FinishReason = c.FinishReason
		}
		if c.Content == nil {
			continue
		}
		for _, part := range c.Content.Parts {
			if part == nil {
				continue
			}
			parts := cand.Content.Parts
			switch {
			case part.Text != "" && !part.Thought:
				if lastWasText {
					last := parts[len(parts)-1]
					last.Text += part.Text
					// Keep the thought signature of a joined text chunk.
					if len(part.ThoughtSignature) > 0 {
						last.ThoughtSignature = part.ThoughtSignature
					}
				} else {
					if hadText {
						stream.TextDelta("\n")
					}
					cand.Content.Parts = append(parts, &genai.Part{Text: part.Text, ThoughtSignature: part.ThoughtSignature})
				}
				hadText, lastWasText = true, true
				stream.TextDelta(part.Text)
				continue
			case part.FunctionCall != nil:
				fc := *part.FunctionCall
				if fc.ID == "" {
					fc.ID = fc.Name + "_" + strconv.Itoa(len(parts))
				}
				copied := *part
				copied.FunctionCall = &fc
				cand.Content.Parts = append(parts, &copied)
				stream.ToolCallStart(fc.ID, fc.Name)
				stream.ToolCallArgs(fc.ID, argsJSON(fc.Args))
				stream.ToolCallEnd(fc.ID)
			default:
				cand.Content.Parts = append(parts, part)
			}
			lastWasText = false
		}
	}
	if len(cand.Content.Parts) == 0 && cand.FinishReason == "" {
		return nil, errors.New("no response candidates from Gemini")
	}
	merged.Candidates = []*genai.Candidate{cand}
	return merged, nil
}
