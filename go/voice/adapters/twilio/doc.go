// Package twilio is the real-phone voice transport over Twilio Media
// Streams, a port of the JavaScript SDK's TwilioAgentAdapter.
//
// The [Adapter] speaks the Media Streams protocol (µ-law 8 kHz JSON frames
// over a WebSocket) and plugs into the voice runtime as a [voice.Transport]:
// wrap it with voice.NewAgent. An outbound call is placed before the run,
// so it is live for the first turn:
//
//	phone, err := twilio.New(twilio.Options{
//		AccountSID:  os.Getenv("TWILIO_ACCOUNT_SID"),
//		AuthToken:   os.Getenv("TWILIO_AUTH_TOKEN"),
//		PhoneNumber: "+14155551234",      // a number on this account
//		Tunnel:      tunnel.Cloudflared{}, // or PublicBaseURL
//	})
//	if err != nil {
//		return err
//	}
//	if err := phone.Connect(ctx); err != nil { // idempotent: the run's Connect is a no-op
//		return err
//	}
//	defer phone.Disconnect(ctx)
//	if err := phone.PlaceCall(ctx, twilio.CallOptions{To: "+14155550000"}); err != nil {
//		return err
//	}
//	res, err := scenario.Run(ctx, scenario.ScenarioConfig{
//		Name:        "IVR menu",
//		Description: "the caller picks billing from the phone menu",
//		Agents: []scenario.AgentAdapter{
//			voice.NewAgent(phone),
//			voice.NewUserSimulator(scenario.NewUserSimulatorAgent(simCfg),
//				voice.UserSimulatorOptions{Voice: "openai/nova"}),
//			scenario.NewJudgeAgent(judgeCfg),
//		},
//		Script: []scenario.ScriptStep{
//			scenario.Agent(), // the menu
//			voice.DTMF("2"),
//			scenario.Agent(),
//			scenario.Judge(),
//		},
//	})
//
// The adapter runs in one of two modes:
//
//   - SDK-owned (convenience) mode, [New]: Connect starts a local webhook and
//     media-stream server and exposes it on PublicBaseURL (or a tunnel).
//     PlaceCall originates an outbound call over Twilio REST; WaitForCall
//     answers an inbound one. A-leg calls (the stream on our own leg, any
//     external number) are guarded by a per-call stream nonce, a destination
//     allowlist, an edge-readiness probe and a call-duration cap.
//   - Embedded mode, [NewStream]: the adapter runs over a media-stream
//     WebSocket an embedder already accepted (a server-side runner with its
//     own listener). There is no SDK-owned server, no tunnel and no REST
//     dialing. [AcceptConn] completes the WebSocket handshake on a raw
//     net.Conn first, for embedders that hand over a hijacked or
//     process-transferred connection.
//
// Inbound audio passes an energy gate ([vad.SpeechGate]) before it is
// queued: a phone line delivers a frame every 20 ms, silence included, and
// the gate is what lets the runtime's tail-silence turn end fire.
package twilio
