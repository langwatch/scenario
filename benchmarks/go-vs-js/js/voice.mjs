// Voice audio paths of the JS SDK per 20 ms frame, the twin of
// go/voicebench/voice_test.go (same inputs, same chain):
//
//   voice.mulaw.encode.frame      pcm16ToMulaw, 8 kHz PCM16 (320 B) to µ-law
//   voice.mulaw.decode.frame      mulawToPcm16, 160 µ-law bytes to PCM16
//   voice.resample.24to8.frame    resamplePcm16 24 kHz to 8 kHz (960 B in)
//   voice.resample.8to24.frame    resamplePcm16 8 kHz to 24 kHz (320 B in)
//   voice.telephony.out.frame     pcm16At24kToMulaw8k (Twilio outbound)
//   voice.telephony.in.frame      mulaw8kToPcm16At24k (Twilio inbound)
//   voice.effects.chain.frame     backgroundNoise(cafe, 0.3), phoneQuality,
//                                 packetLoss(0.05, 20) on one 20 ms frame
//   voice.effects.chain.1s        the same chain on 1 s of audio
//
// The codecs come from the internals bundle (not exported by dist); the
// effects from dist (voice.effects). Run with node --expose-gc.
import { importInternals, importSdk } from "./lib/paths.mjs";
import { bench, benchChecksum } from "./lib/bench.mjs";
import { parseArgs, writeJson } from "./lib/stats.mjs";

process.env.LOG_LEVEL ??= "error";

const args = parseArgs();
const sdk = await importSdk();
const codec = await importInternals();
const fx = sdk.voice.effects;

/** PCM16 LE of a 440 Hz tone, amplitude 12000 (go/voicebench sine). */
function sine(seconds, rate) {
  const n = Math.round(seconds * rate);
  const out = new Uint8Array(2 * n);
  const view = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    view.setInt16(2 * i, Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / rate)), true);
  }
  return out;
}

const pcm24kFrame = sine(0.02, 24000);
const pcm8kFrame = sine(0.02, 8000);
const mulawFrame = codec.pcm16ToMulaw(pcm8kFrame);
const pcm24k1s = sine(1, 24000);

const chain = [fx.backgroundNoise("cafe", 0.3), fx.phoneQuality(), fx.packetLoss(0.05, 20)];
const applyChain = (audio) => chain.reduce((a, f) => f(a), audio);

const cases = {
  "voice.mulaw.encode.frame": () => codec.pcm16ToMulaw(pcm8kFrame),
  "voice.mulaw.decode.frame": () => codec.mulawToPcm16(mulawFrame),
  "voice.resample.24to8.frame": () => codec.resamplePcm16(pcm24kFrame, 24000, 8000),
  "voice.resample.8to24.frame": () => codec.resamplePcm16(pcm8kFrame, 8000, 24000),
  "voice.telephony.out.frame": () => codec.pcm16At24kToMulaw8k(pcm24kFrame),
  "voice.telephony.in.frame": () => codec.mulaw8kToPcm16At24k(mulawFrame),
  "voice.effects.chain.frame": () => applyChain(pcm24kFrame),
  "voice.effects.chain.1s": () => applyChain(pcm24k1s),
};

const results = {};
for (const [name, fn] of Object.entries(cases)) {
  results[name] = await bench(fn);
}
writeJson(args.out, { sdk: "js", node_version: process.version, results, checksum: benchChecksum() });
