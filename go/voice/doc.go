// Package voice is the voice subsystem of the scenario agent-testing
// library: it lets a scenario talk to a voice agent with real audio, record
// the conversation and judge it.
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
package voice
