// Package pipecat is the voice transport to a user-run Pipecat bot, a port
// of the JavaScript SDK's PipecatAgentAdapter.
//
// The bot runs separately (for example python bot.py -t twilio --port 8765)
// and the [Adapter] connects to it as a WebSocket client. Wrap it with
// voice.NewAgent:
//
//	bot, err := pipecat.New(pipecat.Options{URL: "ws://localhost:8765/stream"})
//	if err != nil {
//		return err
//	}
//	res, err := scenario.Run(ctx, scenario.ScenarioConfig{
//		Name:        "pizza order",
//		Description: "the caller orders a pizza for delivery",
//		Agents: []scenario.AgentAdapter{
//			voice.NewAgent(bot),
//			voice.NewUserSimulator(scenario.NewUserSimulatorAgent(simCfg),
//				voice.UserSimulatorOptions{Voice: "openai/nova"}),
//			scenario.NewJudgeAgent(judgeCfg),
//		},
//		Script: []scenario.ScriptStep{
//			scenario.Agent(), // the bot greets on connect
//			scenario.User("Hi, I'd like a large pepperoni pizza."),
//			voice.Interrupt(voice.WithContent("Actually, make it two.")),
//			scenario.Agent(),
//			scenario.Judge(),
//		},
//	})
//
// A bot on the "-t twilio" transport speaks Twilio Media Streams on its
// socket, so the adapter impersonates Twilio: a synthetic connected + start
// handshake with stream and call SIDs, then base64 µ-law 8 kHz media frames
// both ways. A barge-in sends a Twilio "clear" frame, which drops the bot's
// buffered audio. Transport "webrtc" (SmallWebRTC) is not implemented:
// Connect fails with a [voice.PendingTransportError].
package pipecat
