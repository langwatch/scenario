package elevenlabs

import "github.com/langwatch/scenario/go/voice"

// Agent is a hosted ElevenLabs ConvAI agent as a scenario voice agent: the
// default voice turn over a [Transport].
type Agent struct {
	*voice.Agent
	conv *Transport
}

// NewAgent returns the scenario agent for the hosted agent in o (the
// JavaScript SDK's elevenLabsAgent factory). The transport's receive
// budgets follow the agent's ResponseTimeout and ResponseTailSilence.
func NewAgent(o Options, opts ...voice.AgentOption) (*Agent, error) {
	t, err := New(o)
	if err != nil {
		return nil, err
	}
	a := voice.NewAgent(t, opts...)
	t.timings = a
	return &Agent{Agent: a, conv: t}, nil
}

// ConvAI returns the agent's transport, for its transcripts, conversation
// id and audio commit count.
func (a *Agent) ConvAI() *Transport { return a.conv }

// String redacts the API key.
func (a *Agent) String() string { return a.conv.String() }
