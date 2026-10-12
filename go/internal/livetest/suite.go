package livetest

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	scenario "github.com/langwatch/scenario/go"
)

// ScenarioTimeout bounds one live scenario run.
const ScenarioTimeout = 3 * time.Minute

// Provider is one LLM provider module under test.
type Provider struct {
	// Name labels the runs in LangWatch, for example "openai".
	Name string
	// LLM is the provider, already configured with real credentials.
	LLM scenario.LLM
	// Model is a cheap model of the provider that supports tool calling.
	Model string
	// NoImage skips the image scenario for a model without vision.
	NoImage bool
}

// RunProviderSuite runs the provider checks every provider module shares,
// ported from the JavaScript examples (vegetarian-recipe-agent,
// weather-agent, multimodal-images): a direct completion reporting token
// usage, a text scenario with the user simulator, the agent and the judge
// reaching a verdict, a tool call round trip, and an image question. The
// user simulator and the judge run on the provider under test too, so its
// structured tool calls (the judge's finish_test) are exercised as well.
func RunProviderSuite(t *testing.T, p Provider) {
	t.Run("Usage", func(t *testing.T) { providerUsage(t, p) })
	t.Run("Text", func(t *testing.T) { providerText(t, p) })
	t.Run("ToolCall", func(t *testing.T) { providerToolCall(t, p) })
	t.Run("Image", func(t *testing.T) {
		if p.NoImage {
			t.Skip("model has no image input")
		}
		providerImage(t, p)
	})
}

func (p Provider) model(llm scenario.LLM) scenario.ModelConfig {
	return scenario.ModelConfig{LLM: llm, Model: p.Model}
}

// cast returns the user simulator and judge of a provider scenario, on llm.
func (p Provider) cast(llm scenario.LLM, criteria ...string) []scenario.AgentAdapter {
	return []scenario.AgentAdapter{
		scenario.NewUserSimulatorAgent(scenario.UserSimulatorAgentConfig{ModelConfig: p.model(llm)}),
		scenario.NewJudgeAgent(scenario.JudgeAgentConfig{ModelConfig: p.model(llm), Criteria: criteria}),
	}
}

func providerUsage(t *testing.T, p Provider) {
	ctx := Context(t, time.Minute)
	res, err := p.LLM.Inference(ctx, scenario.InferenceParams{
		Model:    p.Model,
		Messages: []scenario.Message{scenario.SystemMsg("Answer with one word."), scenario.UserMsg("Say OK.")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Message.Role != scenario.RoleAssistant {
		t.Errorf("role %q, want assistant", res.Message.Role)
	}
	if res.Usage == nil {
		t.Fatal("no token usage reported")
	}
	if res.Usage.InputTokens <= 0 || res.Usage.OutputTokens <= 0 {
		t.Fatalf("usage %+v, want input and output tokens", *res.Usage)
	}
	t.Logf("%s: %q, usage %+v", p.Name, res.Message.Text(), *res.Usage)
}

func providerText(t *testing.T, p Provider) {
	ctx := Context(t, ScenarioTimeout)
	meter := NewMeter(p.LLM)
	agent := &ChatAgent{LLM: meter, Model: p.Model, System: "You are a vegetarian recipe agent. " +
		"Ask AT MOST ONE short follow-up question, then give a complete but short recipe: " +
		"at most five ingredients and five steps."}
	criteria := []string{
		"The agent provides a recipe",
		"The recipe is vegetarian and has no meat or fish",
	}
	res, err := scenario.Run(ctx, scenario.ScenarioConfig{
		Name:        p.Name + " text: dinner idea",
		Description: "It's saturday evening, the user is hungry and tired, and wants a quick vegetarian recipe for dinner.",
		Agents:      append([]scenario.AgentAdapter{agent}, p.cast(meter, criteria...)...),
		Script: []scenario.ScriptStep{
			scenario.User(), scenario.Agent(),
			scenario.User(), scenario.Agent(),
			scenario.Judge(),
		},
		MaxTurns: 3,
		SetID:    SetID,
	})
	AssertVerdict(t, res, err, criteria)
	if n := countRole(res.Messages, scenario.RoleUser); n < 2 {
		t.Errorf("%d user messages, want the simulator's 2", n)
	}

	calls, without, usage := meter.Totals()
	if calls < 5 {
		t.Errorf("%d LLM calls, want the agent, the simulator and the judge on the provider", calls)
	}
	if without > 0 || usage.InputTokens <= 0 || usage.OutputTokens <= 0 {
		t.Errorf("%d of %d calls without usage, total %+v", without, calls, usage)
	}
	t.Logf("%s: %d calls, usage %+v", p.Name, calls, usage)
}

// WeatherTool is the tool of the tool call scenario (the JavaScript
// weather-agent example, with a deterministic answer).
var WeatherTool = scenario.ToolDefinition{
	Name:        "get_current_weather",
	Description: "Get the current weather in a given city.",
	Parameters: map[string]any{
		"type": "object",
		"properties": map[string]any{
			"city": map[string]any{"type": "string", "description": "The city to get the weather for."},
		},
		"required":             []string{"city"},
		"additionalProperties": false,
	},
}

// weatherAnswer carries a temperature no model would guess, so the final
// answer proves the tool result went back to the model.
const weatherAnswer = "Sunny, 27 degrees Celsius, light wind."

func providerToolCall(t *testing.T, p Provider) {
	ctx := Context(t, ScenarioTimeout)
	var cities []string
	agent := &ChatAgent{
		LLM: p.LLM, Model: p.Model, Tools: []scenario.ToolDefinition{WeatherTool},
		System: "You are a weather assistant. Always look the weather up with get_current_weather " +
			"before answering, then answer in one sentence quoting the temperature.",
		Execute: func(_ context.Context, call scenario.ToolCall) string {
			var args struct {
				City string `json:"city"`
			}
			_ = json.Unmarshal([]byte(call.Arguments), &args)
			cities = append(cities, args.City)
			return weatherAnswer
		},
	}
	criteria := []string{"The agent tells the user the current weather in Barcelona, including the temperature"}
	res, err := scenario.Run(ctx, scenario.ScenarioConfig{
		Name:        p.Name + " tool call: checking the weather",
		Description: "The user is planning a walk in Barcelona today and asks what the weather is like.",
		Agents:      append([]scenario.AgentAdapter{agent}, p.cast(p.LLM, criteria...)...),
		Script: []scenario.ScriptStep{
			scenario.User("What's the weather like in Barcelona right now?"),
			scenario.Agent(),
			scenario.StepFunc(func(ctx context.Context, ex *scenario.Executor) error {
				if !ex.State().HasToolCall(WeatherTool.Name) {
					ex.Fail(ctx, "the agent did not call get_current_weather")
				}
				return nil
			}),
			scenario.Judge(),
		},
		MaxTurns: 2,
		SetID:    SetID,
	})
	AssertVerdict(t, res, err, criteria)
	if len(cities) == 0 || !strings.Contains(strings.ToLower(cities[0]), "barcelona") {
		t.Errorf("tool called with cities %q, want Barcelona", cities)
	}
	var call scenario.ToolCall
	var result, answer scenario.Message
	for _, m := range res.Messages {
		switch {
		case m.Role == scenario.RoleAssistant && len(m.ToolCalls) > 0:
			call = m.ToolCalls[0]
		case m.Role == scenario.RoleTool:
			result = m
		case m.Role == scenario.RoleAssistant:
			answer = m
		}
	}
	if call.ID == "" || result.ToolCallID != call.ID {
		t.Errorf("tool call %q answered by %q", call.ID, result.ToolCallID)
	}
	if !strings.Contains(answer.Text(), "27") {
		t.Errorf("final answer %q does not quote the tool result", answer.Text())
	}
}

func providerImage(t *testing.T, p Provider) {
	ctx := Context(t, ScenarioTimeout)
	agent := &ChatAgent{LLM: p.LLM, Model: p.Model, System: "You are a helpful assistant that describes images. Be brief."}
	criteria := []string{"The agent says the image is red"}
	res, err := scenario.Run(ctx, scenario.ScenarioConfig{
		Name:        p.Name + " multimodal image analysis",
		Description: "The user sends an image and asks which color it is.",
		Agents:      append([]scenario.AgentAdapter{agent}, p.cast(p.LLM, criteria...)...),
		Script: []scenario.ScriptStep{
			scenario.MessageStep(scenario.Message{Role: scenario.RoleUser, Parts: []scenario.Part{
				scenario.TextPart("What color is this image? Answer in one short sentence."),
				scenario.ImagePart("image/png", RedSquarePNG()),
			}}),
			scenario.Agent(),
			scenario.Judge(),
		},
		MaxTurns: 2,
		SetID:    SetID,
	})
	AssertVerdict(t, res, err, criteria)
	last := lastOfRole(res.Messages, scenario.RoleAssistant)
	if !strings.Contains(strings.ToLower(last.Text()), "red") {
		t.Errorf("agent answered %q, want red", last.Text())
	}
}

// AssertVerdict fails the test unless the run succeeded with a verdict on
// every criterion, each passed and explained.
func AssertVerdict(t testing.TB, res *scenario.ScenarioResult, err error, criteria []string) {
	t.Helper()
	if err != nil {
		t.Fatalf("run failed: %v", err)
	}
	if !res.Success {
		t.Fatalf("scenario failed: %s\nunmet: %q\nmessages: %d", res.Reasoning, res.UnmetCriteria, len(res.Messages))
	}
	if res.Reasoning == "" {
		t.Error("verdict without reasoning")
	}
	if len(res.Criteria) != len(criteria) {
		t.Fatalf("%d criterion verdicts, want %d: %+v", len(res.Criteria), len(criteria), res.Criteria)
	}
	for i, c := range res.Criteria {
		if c.Criterion != criteria[i] || c.Status != scenario.CriterionPassed {
			t.Errorf("criterion %d: %+v", i, c)
		}
	}
	if !slices.Equal(res.MetCriteria, criteria) {
		t.Errorf("met criteria %q, want %q", res.MetCriteria, criteria)
	}
}

func countRole(msgs []scenario.Message, role scenario.Role) int {
	n := 0
	for _, m := range msgs {
		if m.Role == role {
			n++
		}
	}
	return n
}

func lastOfRole(msgs []scenario.Message, role scenario.Role) scenario.Message {
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == role {
			return msgs[i]
		}
	}
	return scenario.Message{}
}
