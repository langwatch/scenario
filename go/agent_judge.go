package scenario

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/langwatch/scenario/go/internal"
	"github.com/langwatch/scenario/go/internal/libraries/ptr"
)

const (
	judgePrompt = `
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

	lastMessagePrompt = `
System:

<finish_test>
This is the last message, conversation has reached the maximum number of turns, give your final verdict,
if you don't have enough information to make a verdict, say inconclusive with max turns reached.
</finish_test>
`
)

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
	cfg           JudgeAgentConfig
	spanCollector *SpanCollector
}

func NewJudgeAgent(cfg JudgeAgentConfig) *JudgeAgent {
	return &JudgeAgent{
		cfg: cfg,
	}
}

func (a *JudgeAgent) Role() AgentRole {
	return AgentRoleJudge
}

// GetCriteria returns the judge's configured criteria.
func (a *JudgeAgent) GetCriteria() []string {
	return a.cfg.Criteria
}

func (a *JudgeAgent) Call(ctx context.Context, input AgentInput) (*AgentReturn, error) {
	// Resolve criteria: use JudgmentRequest criteria if provided, otherwise configured criteria
	criteria := a.cfg.Criteria
	if input.JudgmentRequest != nil && len(input.JudgmentRequest.Criteria) > 0 {
		criteria = input.JudgmentRequest.Criteria
	}

	var systemPrompt string
	if a.cfg.SystemPrompt != nil {
		systemPrompt = *a.cfg.SystemPrompt
	} else {
		systemPrompt = buildJudgePrompt(criteria, input.ScenarioConfig.Description)
	}

	lastMessage := input.ScenarioState.CurrentTurn() >= input.ScenarioConfig.MaxTurns
	enforceJudgement := input.JudgmentRequest != nil
	forceDecision := input.JudgmentRequest != nil && input.JudgmentRequest.ForceDecision
	hasCriteria := len(criteria) > 0

	// Build transcript from messages
	transcript := buildTranscriptFromMessages(input.Messages)

	// Build OTel digest if span collector is available
	digest := ""
	if a.spanCollector != nil {
		spans := a.spanCollector.GetSpansForThread(input.ThreadID)
		formatter := &SpanDigestFormatter{}
		digest = formatter.Format(spans)
	}

	// Combine transcript and OTel digest for the judge
	contentForJudge := fmt.Sprintf(`<transcript>
%s
</transcript>
<opentelemetry_traces>
%s
</opentelemetry_traces>`, transcript, digest)

	messages := []Message{
		SystemMsg(systemPrompt),
		UserMsg(contentForJudge),
	}

	if lastMessage {
		messages = append(messages, UserMsg(lastMessagePrompt))
	}

	if enforceJudgement && !hasCriteria {
		return NewScenarioResultAgentReturn(ScenarioResult{
			Success:       false,
			Messages:      []Message{},
			Reasoning:     ptr.Ptr("TestingAgent was called as a judge, but it has no criteria to judge against"),
			MetCriteria:   []string{},
			UnmetCriteria: []string{},
		}), nil
	}

	// Build tools — only include continue_test when not forcing a decision
	tools := createJudgeAgentTools(criteria, forceDecision)

	params := InferenceParams{
		Model:    a.cfg.Model,
		Messages: messages,
		Temperature: ptr.Ptr(ptr.ValueOrDefault(a.cfg.Temperature, 0.0)),
		Tools:    tools,
	}
	if a.cfg.MaxTokens != nil {
		params.MaxTokens = a.cfg.MaxTokens
	}

	// Force tool_choice to finish_test when ForceDecision or last message
	if (forceDecision || lastMessage) && hasCriteria {
		params.ToolChoice = &ToolChoice{
			Type:         "function",
			FunctionName: "finish_test",
		}
	}

	result, err := a.cfg.LLM.Inference(ctx, params)
	if err != nil {
		return nil, err
	}

	if len(result.Message.ToolCalls) == 0 {
		return nil, errors.New("judge agent response has no tool calls")
	}

	toolCall := result.Message.ToolCalls[0]

	switch toolCall.Name {
	case "continue_test":
		// Return nil to signal continue
		return nil, nil

	case "finish_test":
		toolArguments, err := internal.ParseJudgeAgentFinishTestToolArguments(toolCall.Arguments)
		if err != nil {
			return nil, fmt.Errorf("failed to parse finish_test arguments: %w", err)
		}

		passedCriteria := []string{}
		failedCriteria := []string{}

		// Map param names back to original criteria
		paramToCriterion := make(map[string]string)
		for _, c := range criteria {
			paramToCriterion[criterionNameToParamName(c)] = c
		}

		for key, reasoning := range toolArguments.Criteria {
			criterion := key
			if original, ok := paramToCriterion[key]; ok {
				criterion = original
			}

			reasoningBool, ok := reasoning.(bool)
			if ok {
				if reasoningBool {
					passedCriteria = append(passedCriteria, criterion)
				} else {
					failedCriteria = append(failedCriteria, criterion)
				}
				continue
			}

			// Handle string values like "true", "false", "inconclusive"
			reasoningStr, ok := reasoning.(string)
			if ok {
				if reasoningStr == "true" {
					passedCriteria = append(passedCriteria, criterion)
				} else {
					failedCriteria = append(failedCriteria, criterion)
				}
			}
		}

		return NewScenarioResultAgentReturn(ScenarioResult{
			Success:       toolArguments.Verdict == "success" && len(failedCriteria) == 0,
			Messages:      messages,
			Reasoning:     ptr.Ptr(toolArguments.Reasoning),
			MetCriteria:   passedCriteria,
			UnmetCriteria: failedCriteria,
		}), nil

	default:
		return nil, errors.New("judge agent response tool call is not of a known name")
	}
}

func createJudgeAgentTools(criteria []string, forceDecision bool) []ToolDefinition {
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

	tools := []ToolDefinition{}

	// Only include continue_test when not forcing a decision
	if !forceDecision {
		tools = append(tools, ToolDefinition{
			Name:        "continue_test",
			Description: "Continue the test with the next step",
			Strict:      true,
			Parameters: map[string]any{
				"type":                 "object",
				"properties":           map[string]any{},
				"required":             []any{},
				"additionalProperties": false,
			},
		})
	}

	tools = append(tools, ToolDefinition{
		Name:        "finish_test",
		Description: "Complete the test with a final verdict",
		Strict:      true,
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"criteria": map[string]any{
					"type":                 "object",
					"properties":           criteriaMap,
					"required":             criteriaNames,
					"additionalProperties": false,
					"description":          "Strict verdict for each criterion",
				},
				"reasoning": map[string]any{
					"type":        "string",
					"description": "Explanation of what the final verdict should be",
				},
				"verdict": map[string]any{
					"type":        "string",
					"enum":        []any{"success", "failure", "inconclusive"},
					"description": "The final verdict of the test",
				},
			},
			"required":             []any{"criteria", "reasoning", "verdict"},
			"additionalProperties": false,
		},
	})

	return tools
}

// buildTranscriptFromMessages builds a plain-text transcript from messages for judge evaluation.
func buildTranscriptFromMessages(messages []Message) string {
	var lines []string
	for _, msg := range messages {
		contentJSON, err := json.Marshal(msg.Content)
		if err != nil {
			contentJSON = []byte(msg.Content)
		}
		lines = append(lines, fmt.Sprintf("%s: %s", msg.Role, string(contentJSON)))
	}
	return strings.Join(lines, "\n")
}
