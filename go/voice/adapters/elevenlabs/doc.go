// Package elevenlabs is the hosted ElevenLabs Conversational AI (ConvAI)
// voice transport: ElevenLabs runs the STT, LLM and TTS loop; the transport
// carries canonical PCM16 at 24 kHz in both directions, unconverted.
//
// [NewAgent] wraps a [Transport] as a scenario voice agent. A hosted agent
// greets on connect, so a script leads with an agent step:
//
//	agent, err := elevenlabs.NewAgent(elevenlabs.Options{
//		AgentID: os.Getenv("ELEVENLABS_AGENT_ID"),
//	})
//	if err != nil {
//		return err
//	}
//	res, err := scenario.Run(ctx, scenario.ScenarioConfig{
//		Name:        "account question",
//		Description: "the caller asks about their account",
//		Agents: []scenario.AgentAdapter{
//			agent,
//			voice.NewUserSimulator(scenario.NewUserSimulatorAgent(simCfg),
//				voice.UserSimulatorOptions{Voice: "openai/nova"}),
//			scenario.NewJudgeAgent(judgeCfg),
//		},
//		Script: []scenario.ScriptStep{
//			scenario.Agent(), // the greeting
//			scenario.User("Hello, I have a question about my account."),
//			scenario.Agent(),
//			scenario.Judge(),
//		},
//	})
//
// The API key is [Options].APIKey, else ELEVENLABS_CONVAI_API_KEY, else
// ELEVENLABS_API_KEY; ELEVENLABS_BASE_URL points the signed-URL mint at a
// gateway.
//
// The ConvAI WebSocket protocol is implemented here directly (there is no Go
// SDK), putting on the wire what the official JavaScript SDK does: the
// signed-URL mint for a private agent, the
// conversation_initiation_client_data handshake, base64 user_audio_chunk
// frames, ping/pong keepalive, audio gating after an interruption by
// event_id, and the client tool reply. On top of it the transport keeps the
// JavaScript adapter's reliability recipe:
//
//   - a continuous microphone: a 20 ms pump feeds the user turn's PCM as
//     960-byte frames at real-time cadence, then closing silence so the
//     server VAD sees the audio-to-silence transition, then pauses once the
//     agent answered so the inter-turn gap is not read as the user leaving;
//   - a receive with a sliding idle deadline that inbound frames re-arm
//     (only turn activity once the agent spoke) and an absolute ceiling
//     nothing re-arms, each with its own diagnosis;
//   - the agent's own transcript (agent_response, corrections) as the turn
//     transcript, deliberate hangups (end_call, transfer_*), and the
//     conversation id stamped on the first live span.
//
// ConvAI has no client-side cancel, so the transport does not advertise
// interruption: a barge-in is user audio sent while the agent speaks, which
// the server's VAD detects. [Transport] is usable on its own, outside a
// scenario run.
package elevenlabs
