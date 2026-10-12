package redteam

import "testing"

var benchSink string

func BenchmarkRenderMetapromptTemplate(b *testing.B) {
	ends := (CrescendoStrategy{}).PhaseEnds(30)
	p := MetapromptParams{Target: placeholderTarget, Description: "A bank support agent", TotalTurns: 30, PhaseEnds: &ends}
	b.ReportAllocs()
	for b.Loop() {
		benchSink = RenderMetapromptTemplate(DefaultMetapromptTemplate, p)
	}
}

func benchPrompt(b *testing.B, s Strategy) {
	p := PromptParams{Target: placeholderTarget, CurrentTurn: 12, TotalTurns: 30, ScenarioDescription: "A bank support agent", MetapromptPlan: "placeholder plan"}
	b.ReportAllocs()
	for b.Loop() {
		benchSink = s.BuildSystemPrompt(p)
	}
}

func BenchmarkCrescendoSystemPrompt(b *testing.B) { benchPrompt(b, CrescendoStrategy{}) }
func BenchmarkGOATSystemPrompt(b *testing.B)      { benchPrompt(b, &GOATStrategy{}) }

func BenchmarkParseAttackerOutput(b *testing.B) {
	g := &GOATStrategy{}
	raw := "```json\n{\"observation\": \"placeholder observation\", \"strategy\": \"HYPOTHETICAL FRAMING\", \"reply\": \"placeholder attack\"}\n```"
	b.ReportAllocs()
	for b.Loop() {
		benchSink = g.ParseAttackerOutput(raw).Reply
	}
}

func BenchmarkParseScore(b *testing.B) {
	raw := `{"score": 7, "adaptation": "placeholder hint"}`
	b.ReportAllocs()
	for b.Loop() {
		benchSink = parseScore(raw).hint
	}
}

func BenchmarkChosenTechniqueIDs(b *testing.B) {
	g := &GOATStrategy{}
	b.ReportAllocs()
	for b.Loop() {
		benchSink = g.ChosenTechniqueIDs("combining RESPONSE PRIMING with HYPOTHETICAL_FRAMING")[0]
	}
}

func BenchmarkDetectRefusal(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		benchSink = detectRefusal("Sure, here is a placeholder answer about the topic you asked for.").String()
	}
}
