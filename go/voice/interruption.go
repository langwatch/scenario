package voice

// InterruptionStrategy picks the phrase of a user-simulator interruption.
type InterruptionStrategy string

// Interruption strategies.
const (
	// StrategyContextual lets the user simulator generate the interjection.
	StrategyContextual InterruptionStrategy = "contextual"
	// StrategyRandomPhrase draws from a canned phrase list.
	StrategyRandomPhrase InterruptionStrategy = "random_phrase"
)

// CannedPhrases are short, realistic mid-turn interruptions.
var CannedPhrases = []string{
	"Wait, that's not right",
	"No no, let me explain again",
	"Hold on a second",
	"Actually scratch that",
	"Sorry to cut you off",
	"Wait I forgot to mention",
	"Hmm, let me correct you",
}

// ContextualPrompt is the system prompt for generating a contextual
// interjection with an LLM.
const ContextualPrompt = "You are simulating a user interrupting an AI agent mid-sentence. " +
	"Produce a SHORT (2–8 word) interjection that would realistically " +
	"cut the agent off. Do not answer their question. Do not greet them. " +
	"Just the interjection — no quotes, no punctuation besides a comma or period."

// InterruptionConfig configures probabilistic barge-ins by the user
// simulator during Proceed.
type InterruptionConfig struct {
	// Probability in [0, 1] that an agent turn is interrupted.
	Probability float64
	// DelayRange is the inclusive range, in seconds, of the wait between the
	// agent starting to speak and the barge-in.
	DelayRange [2]float64
	Strategy   InterruptionStrategy
	// Phrases is the pool of the random_phrase strategy.
	Phrases []string
}

// NewInterruptionConfig returns the defaults: probability 0.3, delay
// 0.5–3 s, random canned phrases.
func NewInterruptionConfig(probability float64) InterruptionConfig {
	return InterruptionConfig{
		Probability: probability,
		DelayRange:  [2]float64{0.5, 3.0},
		Strategy:    StrategyRandomPhrase,
		Phrases:     CannedPhrases,
	}
}

func (c InterruptionConfig) strategy() InterruptionStrategy {
	if c.Strategy == "" {
		return StrategyRandomPhrase
	}
	return c.Strategy
}

// ShouldInterrupt draws whether to interrupt.
func (c InterruptionConfig) ShouldInterrupt(rng func() float64) bool {
	return rng() < c.Probability
}

// SampleDelay draws a delay in seconds from DelayRange.
func (c InterruptionConfig) SampleDelay(rng func() float64) float64 {
	lo, hi := c.DelayRange[0], c.DelayRange[1]
	return lo + rng()*(hi-lo)
}

// PickRandomPhrase draws a phrase from Phrases (CannedPhrases when nil).
func (c InterruptionConfig) PickRandomPhrase(rng func() float64) string {
	phrases := c.Phrases
	if phrases == nil {
		phrases = CannedPhrases
	}
	if len(phrases) == 0 {
		return ""
	}
	return phrases[min(len(phrases)-1, int(rng()*float64(len(phrases))))]
}
