// Package voice is the voice subsystem of the scenario agent-testing
// library: it lets a scenario talk to a voice agent with real audio, record
// the conversation and judge it.
//
// A voice agent is a [Transport] (the wire to the agent) wrapped by
// [NewAgent] into a scenario agent. Adapters for OpenAI Realtime, Gemini
// Live, ElevenLabs, Pipecat, Twilio and composed STT → LLM → TTS pipelines
// live under adapters/. A user simulator gets a voice with
// [NewUserSimulator]. Both bring the per-run [Session] into the run, which
// connects the transports, records every segment and timeline event, voices
// user turns, runs barge-ins, transcribes audio for the judge and attaches
// the recording to the result:
//
//	res, err := scenario.Run(ctx, scenario.ScenarioConfig{
//		Name:        "booking by phone",
//		Description: "the caller books a table for two",
//		Agents: []scenario.AgentAdapter{
//			voice.NewAgent(transport),
//			voice.NewUserSimulator(scenario.NewUserSimulatorAgent(simCfg),
//				voice.UserSimulatorOptions{Voice: "openai/nova"}),
//			scenario.NewJudgeAgent(judgeCfg),
//		},
//		Script: []scenario.ScriptStep{
//			scenario.Proceed(scenario.Turns(3)),
//			voice.Interrupt(voice.WithContent("sorry, make that four")),
//			scenario.Judge(),
//		},
//	}, voice.WithConfig(voice.Config{STTModel: "openai/gpt-4o-transcribe"}))
//	rec := voice.ResultOf(res).Recording
//	rec.SaveSegments("out/booking", voice.SaveSegmentsOptions{})
//
// Audio crossing the framework boundary is always an [AudioChunk]: PCM16
// little-endian, 24 kHz, mono. Adapters convert to and from their transport
// format at the edge, using the codecs in the audio subpackage.
//
// Subpackages:
//   - audio: canonical chunk, PCM16, WAV, µ-law, resampling, RMS, FFT
//   - vad: SDK-side voice-activity detection and the phone-line speech gate
//   - effects: post-TTS audio degradation (noise, phone line, packet loss, ...)
//   - stt, tts: speech-to-text and text-to-speech providers ("provider/model")
//   - ffmpeg: decoding non-WAV audio files through an external ffmpeg
//   - voicetest: in-memory fakes for offline voice tests
package voice
