package scenario

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/langwatch/scenario/go/internal/libraries/ptr"

	"github.com/openai/openai-go"
	"github.com/openai/openai-go/shared"
)

const judgePrompt = `
<role>
You are an LLM as a judge watching a simulated conversation as it plays out live to determine if the agent under test meets the criteria or not.
</role>

<goal>
Your goal is to determine if you already have enough information to make a verdict of the scenario below, or if the conversation should continue for longer.
If you do have enough information, use the finish_test tool to determine if all the criteria have been met, if not, use the continue_test tool to let the next step play out.
</goal>

<scenario>
{{.Description}}
</scenario>

<criteria>
{{.FormattedCriteriaList}}
</criteria>

<rules>
- Be strict, do not let the conversation continue if the agent already broke one of the "do not" or "should not" criterias.
- DO NOT make any judgment calls that are not explicitly listed in the success or failure criteria, withhold judgement if necessary
</rules>
`

func buildJudgePrompt(criteria []string, description string) string {
	formattedCriteriaList := ""
	for i, criterion := range criteria {
		formattedCriteriaList += fmt.Sprintf("%d. %s\n", i+1, criterion)
	}

	populatedPrompt := strings.ReplaceAll(judgePrompt, "{{.FormattedCriteriaList}}", formattedCriteriaList)
	populatedPrompt = strings.ReplaceAll(populatedPrompt, "{{.Description}}", description)

	return populatedPrompt
}

type JudgeAgentConfig struct {
	AgentConfig

	SystemPrompt *string
	Criteria     []string
}

type JudgeAgent struct {
	cfg JudgeAgentConfig
	llm openai.Client
}

func NewJudgeAgent(cfg JudgeAgentConfig) *JudgeAgent {
	return &JudgeAgent{
		cfg: cfg,

		// TODO(afr): Handle properly for other llm providers
		llm: openai.NewClient(openai.DefaultClientOptions()...),
	}
}

func (a *JudgeAgent) Role() AgentRole {
	return AgentRoleJudge
}

func (a *JudgeAgent) Call(ctx context.Context, input AgentInput) (*AgentReturn, error) {
	var systemPrompt string
	if a.cfg.SystemPrompt != nil {
		systemPrompt = *a.cfg.SystemPrompt
	} else {
		systemPrompt = buildJudgePrompt(a.cfg.Criteria, input.ScenarioConfig.Description)
	}

	lastMessage := input.ScenarioState.CurrentTurn() >= input.ScenarioConfig.MaxTurns
	enforceJudgement := input.JudgmentRequest
	hasCriteria := len(a.cfg.Criteria) > 0
	messages := append(
		[]openai.ChatCompletionMessageParamUnion{openai.SystemMessage(systemPrompt)},
		input.Messages...,
	)

	if enforceJudgement && !hasCriteria {
		return NewScenarioResultAgentReturn(ScenarioResult{
			Success:       false,
			Messages:      []openai.ChatCompletionMessageParamUnion{},
			Reasoning:     ptr.Ptr("TestingAgent was called as a judge, but it has no criteria to judge against"),
			MetCriteria:   []string{},
			UnmetCriteria: []string{},
		}), nil
	}

	// Create tools

	params := openai.ChatCompletionNewParams{
		Messages:    messages,
		Model:       a.cfg.Model, // TODO(afr): load model id format
		Temperature: openai.Opt(ptr.ValueOrDefault(a.cfg.Temperature, 0.0)),
		Tools:       createJudgeAgentTools(a.cfg.Criteria),
	}
	if a.cfg.MaxTokens != nil {
		params.MaxCompletionTokens = openai.Opt(*a.cfg.MaxTokens)
	}

	completion, err := a.llm.Chat.Completions.New(ctx, params)
	if err != nil {
		return nil, err
	}

	if len(completion.Choices) == 0 {
		return nil, errors.New("user simulator agent had no response choices")
	}

	return NewMessageAgentReturn(openai.ChatCompletionMessageParamUnion{
		OfAssistant: ptr.Ptr(completion.Choices[0].Message.ToAssistantMessageParam()),
	}), nil
}

func createJudgeAgentTools(criteria []string) []openai.ChatCompletionToolParam {
	criteriaMap := map[string]any{}
	criteriaNames := []string{}
	for _, criterion := range criteria {
		paramName := criterionNameToParamName(criterion)
		criteriaNames = append(criteriaNames, paramName)
		criteriaMap[paramName] = map[string]any{
			"enum":        []any{true, false, "inconclusive"},
			"description": criterion,
		}
	}

	tools := []openai.ChatCompletionToolParam{{
		Type: "function",
		Function: shared.FunctionDefinitionParam{
			Name:        "continue_test",
			Description: openai.Opt("Continue the test with the next step"),
			Strict:      openai.Opt(true),
			Parameters: openai.FunctionParameters{
				"type":                 "object",
				"properties":           map[any]any{},
				"required":             []any{},
				"additionalProperties": false,
			},
		},
	}, {
		Type: "function",
		Function: shared.FunctionDefinitionParam{
			Name:        "finish_test",
			Description: openai.Opt("Complete the test with a final verdict"),
			Strict:      openai.Opt(true),
			Parameters: openai.FunctionParameters{
				"type": "object",
				"properties": map[any]any{
					"criteria": map[any]any{
						"type":                 "object",
						"properties":           criteriaMap,
						"required":             criteriaNames,
						"additionalProperties": false,
						"description":          "Strict verdict for each criterion",
					},
					"reasoning": map[any]any{
						"type":        "string",
						"description": "Explanation of what the final verdict should be",
					},
					"verdict": map[any]any{
						"type":        "string",
						"enum":        []any{"success", "failure", "inconclusive"},
						"description": "The final verdict of the test",
					},
				},
				"required":             []any{"criteria", "reasoning", "verdict"},
				"additionalProperties": false,
			},
		},
	}}

	return tools
}
