// Package openairealtime is the OpenAI Realtime voice adapter. The model
// itself is the agent under test or, with the user role, the voice user
// simulator. It speaks the GA Realtime wire protocol over a WebSocket.
//
// As the agent under test, next to a voice user simulator and a judge:
//
//	res, err := scenario.Run(ctx, scenario.ScenarioConfig{
//		Name:        "weekend trip",
//		Description: "the user asks for help planning a weekend trip",
//		Agents: []scenario.AgentAdapter{
//			openairealtime.New(openairealtime.Options{
//				Voice:        "alloy",
//				Instructions: "You are a helpful travel assistant. Keep answers short.",
//			}),
//			voice.NewUserSimulator(scenario.NewUserSimulatorAgent(simCfg),
//				voice.UserSimulatorOptions{Voice: "openai/nova"}),
//			scenario.NewJudgeAgent(judgeCfg),
//		},
//		Script: []scenario.ScriptStep{
//			scenario.User("Hi, can you help me plan a weekend trip?"),
//			scenario.Agent(),
//			scenario.Judge(),
//		},
//	})
//
// As the user, the model speaks scripted lines itself (no TTS) and
// generates its own turns during Proceed:
//
//	user := openairealtime.New(openairealtime.Options{
//		Role:         scenario.AgentRoleUser,
//		Voice:        "marin",
//		Instructions: "You are an impatient customer whose order is late.",
//	})
//
// Wire protocol:
//   - endpoint wss://api.openai.com/v1/realtime?model=<model>, bearer auth;
//   - on connect, session.update with session.type "realtime", PCM16 24 kHz
//     in and out, the voice, and turn detection off (the adapter commits
//     each user turn and requests the response itself);
//   - user audio goes out as input_audio_buffer.append (base64 PCM16);
//   - agent audio comes back as response.output_audio.delta.
//
// The socket's credential is minted through package broker when an endpoint
// resolves (OPENAI_BASE_URL / OPENAI_API_KEY), so a LangWatch AI Gateway
// budgets and bills the session; otherwise the vendor is dialed directly.
package openairealtime
