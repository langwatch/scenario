package scenario

import (
	"context"
	"fmt"
	"testing"
)

func benchMessages(n int) []Message {
	msgs := make([]Message, 0, n)
	for i := 0; i < n; i++ {
		if i%2 == 0 {
			msgs = append(msgs, UserMsg(fmt.Sprintf("user message number %d with some text", i)))
		} else {
			msgs = append(msgs, AssistantMsg(fmt.Sprintf("assistant reply number %d with some longer text in it", i)))
		}
	}
	return msgs
}

// BenchmarkAGUIConvert20 converts 20 messages to AG-UI from scratch.
func BenchmarkAGUIConvert20(b *testing.B) {
	msgs := benchMessages(20)
	for i := range msgs {
		msgs[i].ID = generateMessageID()
	}
	b.ReportAllocs()
	for b.Loop() {
		for _, m := range msgs {
			_ = aguiRows(m)
		}
	}
}

// BenchmarkEventEncodeSnapshot20 builds one MESSAGE_SNAPSHOT body of a
// 20-message conversation, as the executor does after every message (the
// per-message AG-UI JSON is cached, so only the envelope is new).
func BenchmarkEventEncodeSnapshot20(b *testing.B) {
	st := newExecutionState(ScenarioConfig{MaxTurns: 10})
	for _, m := range benchMessages(20) {
		st.add(m, "")
	}
	base := eventBase{batchRunID: "b", scenarioID: "i", scenarioRunID: "r", scenarioSetID: "s"}
	b.ReportAllocs()
	for b.Loop() {
		_ = base.snapshotPayload(1700000000000, st.aguiRowsJSON())
	}
}

// BenchmarkScenarioRun10Turns runs a full scenario with a fake LLM: user
// simulator, echo agent and a judge that continues nine times and then
// decides, like the baseline benchmark of the previous implementation.
func BenchmarkScenarioRun10Turns(b *testing.B) {
	criteria := []string{"agent responds"}
	verdict := finishArgs(criteria, "passed")
	b.ReportAllocs()
	for b.Loop() {
		judgeCalls := 0
		llm := &fakeLLM{answer: func(_ int, p InferenceParams) (*InferenceResult, error) {
			if len(p.Tools) == 0 {
				return textAnswer("hello there agent"), nil
			}
			judgeCalls++
			switch {
			case hasTool(p, "finish_test"):
				return toolAnswer("finish_test", verdict), nil
			case judgeCalls >= 10:
				return toolAnswer("make_verdict", "{}"), nil
			}
			return toolAnswer("continue_test", "{}"), nil
		}}
		res, err := Run(context.Background(), ScenarioConfig{
			Name: "bench", Description: "bench", MaxTurns: 20,
			Agents: []AgentAdapter{
				&echoAgent{text: "echo reply from the agent under test"},
				NewUserSimulatorAgent(UserSimulatorAgentConfig{ModelConfig: ModelConfig{LLM: llm, Model: "m"}}),
				NewJudgeAgent(JudgeAgentConfig{ModelConfig: ModelConfig{LLM: llm, Model: "m"}, Criteria: criteria}),
			},
		})
		if err != nil || !res.Success {
			b.Fatalf("bad run %v %+v", err, res)
		}
	}
}
