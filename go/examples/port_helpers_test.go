package examples

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	scenario "github.com/langwatch/scenario/go"
	"github.com/openai/openai-go/v3"
)

// roleAgent adapts a function to any agent role, for stand-in users and
// judges that need no model.
type roleAgent struct {
	role scenario.AgentRole
	call scenario.AgentFunc
}

func (a roleAgent) Role() scenario.AgentRole { return a.role }

func (a roleAgent) Call(ctx context.Context, input scenario.AgentInput) (*scenario.AgentReturn, error) {
	return a.call(ctx, input)
}

// fixtureImage reads the demo image shared with the JavaScript examples.
func fixtureImage(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "scenario.webp"))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// singleToolCallAgent asks the model once. When the model calls a tool, the
// first call runs through execute and the turn returns the call and its
// result, leaving the reply to the next turn; a failing tool becomes an
// "Error: ..." result the model can tell the user about. Otherwise the turn
// is the model's text.
func singleToolCallAgent(systemPrompt string, tool scenario.ToolDefinition, execute func(scenario.ToolCall) (string, error)) scenario.AgentFunc {
	return func(ctx context.Context, input scenario.AgentInput) (*scenario.AgentReturn, error) {
		res, err := newLLM().Inference(ctx, scenario.InferenceParams{
			Model:      "gpt-4.1-mini",
			Messages:   append([]scenario.Message{scenario.SystemMsg(systemPrompt)}, input.Messages...),
			Tools:      []scenario.ToolDefinition{tool},
			ToolChoice: &scenario.ToolChoice{Type: scenario.ToolChoiceAuto},
		})
		if err != nil {
			return nil, err
		}
		if len(res.Message.ToolCalls) == 0 {
			return scenario.TextReturn(res.Message.Content), nil
		}
		call := res.Message.ToolCalls[0]
		output, err := execute(call)
		if err != nil {
			output = "Error: " + err.Error()
		}
		return scenario.MessagesReturn(
			scenario.Message{Role: scenario.RoleAssistant, ToolCalls: []scenario.ToolCall{call}},
			scenario.ToolMsg(call.ID, output),
		), nil
	}
}

// wireMessage is the chat message the in-process HTTP agents exchange.
type wireMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// toWire converts the conversation to its text-only wire form.
func toWire(msgs []scenario.Message) []wireMessage {
	out := make([]wireMessage, len(msgs))
	for i, m := range msgs {
		out[i] = wireMessage{Role: string(m.Role), Content: m.Text()}
	}
	return out
}

// fromWire converts wire messages back to scenario messages.
func fromWire(msgs []wireMessage) []scenario.Message {
	out := make([]scenario.Message, len(msgs))
	for i, m := range msgs {
		out[i] = scenario.Message{Role: scenario.Role(m.Role), Content: m.Content}
	}
	return out
}

// lastText is the text of the latest message, or "" for none.
func lastText(msgs []scenario.Message) string {
	if len(msgs) == 0 {
		return ""
	}
	return msgs[len(msgs)-1].Text()
}

// post sends body as JSON with the extra headers and returns the response
// of a 200 answer; the caller closes its body.
func post(ctx context.Context, url string, headers map[string]string, body any) (*http.Response, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("remote agent returned HTTP %d", resp.StatusCode)
	}
	return resp, nil
}

// postJSON posts body and decodes the JSON answer into out.
func postJSON(ctx context.Context, url string, headers map[string]string, body, out any) error {
	resp, err := post(ctx, url, headers, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return json.NewDecoder(resp.Body).Decode(out)
}

// streamChat streams the model's answer to one user message, handing each
// text delta to onDelta as it arrives.
func streamChat(ctx context.Context, systemPrompt, userText string, onDelta func(string) error) error {
	client := openai.NewClient() // uses OPENAI_API_KEY
	stream := client.Chat.Completions.NewStreaming(ctx, openai.ChatCompletionNewParams{
		Model: "gpt-4.1-mini",
		Messages: []openai.ChatCompletionMessageParamUnion{
			openai.SystemMessage(systemPrompt),
			openai.UserMessage(userText),
		},
	})
	defer stream.Close()
	for stream.Next() {
		for _, choice := range stream.Current().Choices {
			if choice.Delta.Content == "" {
				continue
			}
			if err := onDelta(choice.Delta.Content); err != nil {
				return err
			}
		}
	}
	return stream.Err()
}
