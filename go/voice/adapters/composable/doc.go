// Package composable is a local STT -> LLM -> TTS voice agent: user audio
// is transcribed, the running conversation goes to a text LLM, and the
// reply is synthesized. Each seam can be swapped without touching the other
// two, which keeps prompts, model choice and tool calls under the caller's
// control.
//
//	agent, err := composable.NewAgent(composable.Options{
//		STT:          stt.NewOpenAI(stt.OpenAIOptions{}),
//		LLM:          llm, // any scenario.LLM
//		Model:        "gpt-4.1-mini",
//		Voice:        "openai/alloy",
//		SystemPrompt: "You are a friendly support agent. Keep replies short.",
//	})
//	if err != nil {
//		return err
//	}
//	agent.Composable().SetSTT(stt.NewElevenLabs(stt.ElevenLabsOptions{})) // swap one seam
//
//	res, err := scenario.Run(ctx, scenario.ScenarioConfig{
//		Name:        "plan question",
//		Description: "the user asks about their plan",
//		Agents: []scenario.AgentAdapter{
//			agent,
//			voice.NewUserSimulator(scenario.NewUserSimulatorAgent(simCfg),
//				voice.UserSimulatorOptions{Voice: "openai/nova"}),
//			scenario.NewJudgeAgent(judgeCfg),
//		},
//	})
//
// [NewElevenLabsAgent] is the ElevenLabs-flavoured preset (ElevenLabs STT
// and TTS around any LLM). It is not the hosted ElevenLabs agent: that is
// package elevenlabs.
package composable
