// Package geminilive is the Gemini Live native-audio voice adapter. STT, the
// model and TTS all run at Google; audio flows both ways as raw PCM16 over
// the Live API's WebSocket (BidiGenerateContent). The API key is
// [Options].APIKey, else GEMINI_API_KEY, else GOOGLE_API_KEY.
//
//	res, err := scenario.Run(ctx, scenario.ScenarioConfig{
//		Name:        "trip to Japan",
//		Description: "the user plans a trip to Japan",
//		Agents: []scenario.AgentAdapter{
//			geminilive.New(geminilive.Options{
//				SystemInstruction: "You are a helpful assistant. Keep answers short.",
//			}),
//			voice.NewUserSimulator(scenario.NewUserSimulatorAgent(simCfg),
//				voice.UserSimulatorOptions{Voice: "openai/nova"}),
//			scenario.NewJudgeAgent(judgeCfg),
//		},
//		Script: []scenario.ScriptStep{
//			scenario.User("Hello, I'm planning a trip to Japan next month."),
//			scenario.Agent(),
//			scenario.Judge(),
//		},
//	})
//
// Sample rates: canonical 24 kHz internally; Gemini ingests 16 kHz (user
// audio is resampled at the wire) and emits 24 kHz.
//
// Automatic activity detection is off: each SendAudio is one complete user
// turn wrapped in activityStart / activityEnd, so the model replies the
// moment the turn closes. The protocol has no client-side cancel: a
// barge-in works because the next activityStart makes Gemini cut its
// in-flight reply.
package geminilive
