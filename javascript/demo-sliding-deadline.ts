/**
 * demo-sliding-deadline.ts
 *
 * Standalone behavior demo for the sliding-idle-deadline fix (issue #661 / #668).
 *
 * Scenario:
 *   receiveAudio timeout = 500ms (0.5 s)
 *   Pings arrive every 250ms — 8 pings = 2000ms total silent stretch
 *   Without fix:  timer fires at 500ms → TimeoutError
 *   With fix:     each ping resets the 500ms idle deadline → audio at ~2100ms resolves OK
 *
 * Run: node_modules/.bin/tsx demo-sliding-deadline.ts
 */
import { ElevenLabsAgentAdapter } from "./src/voice/adapters/elevenlabs.js";
import { Buffer } from "node:buffer";
import type { RawData } from "ws";

// ── timing constants ──────────────────────────────────────────────────────────
const TIMEOUT_S = 0.5;         // 500ms raw idle deadline
const PING_INTERVAL_MS = 250;  // each ping resets the timer — buys another 500ms
const N_PINGS = 8;             // 8 × 250ms = 2000ms total >> 500ms without fix
const AUDIO_DELAY_MS = 100;    // audio arrives 100ms after last ping

// ── helpers ───────────────────────────────────────────────────────────────────
const t0 = process.hrtime.bigint();
function elapsed(): string {
  const ms = Number((process.hrtime.bigint() - t0) / 1_000_000n);
  return `+${ms.toString().padStart(5)}ms`;
}

function pingEvent(id: number): Buffer {
  return Buffer.from(JSON.stringify({ type: "ping", ping_event: { event_id: id } }));
}

function audioEvent(): Buffer {
  const silence = new Uint8Array(100); // 100 bytes PCM16 silence (even, valid)
  const b64 = Buffer.from(silence).toString("base64");
  return Buffer.from(
    JSON.stringify({ type: "audio", audio_event: { audio_base_64: b64 } }),
  );
}

// ── fake WebSocket ─────────────────────────────────────────────────────────────
function createFakeWS() {
  const onceHandlers = new Map<string, (...args: unknown[]) => void>();
  const onHandlers   = new Map<string, (...args: unknown[]) => void>();
  let openFired = false;

  const ws = {
    readyState: 1 as number | undefined,
    send: (data: string) => {
      try {
        const msg = JSON.parse(data) as Record<string, unknown>;
        if (msg["type"] === "pong") {
          console.log(`${elapsed()} [ws→server] pong event_id=${String(msg["event_id"])}`);
        }
      } catch { /* ignore */ }
    },
    close: () => {},
    once: (event: string, listener: (...args: unknown[]) => void) => {
      onceHandlers.set(event, listener);
      if (event === "open" && !openFired) {
        openFired = true;
        setImmediate(() => {
          const h = onceHandlers.get("open");
          if (h) { onceHandlers.delete("open"); h(); }
        });
      }
      return ws;
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      onHandlers.set(event, listener);
      return ws;
    },
    removeAllListeners: () => { onceHandlers.clear(); onHandlers.clear(); },
    inject: (data: Buffer) => { onHandlers.get("message")?.(data as unknown as RawData); },
  };
  return ws;
}

// ── main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== ElevenLabsAgentAdapter: sliding-idle-deadline demo ===");
  console.log();
  console.log(`  receiveAudio timeout : ${TIMEOUT_S * 1000}ms`);
  console.log(`  ping interval        : ${PING_INTERVAL_MS}ms`);
  console.log(`  total silent stretch : ${N_PINGS * PING_INTERVAL_MS}ms  (${N_PINGS} pings)`);
  console.log(`  audio arrives at     : ~${N_PINGS * PING_INTERVAL_MS + AUDIO_DELAY_MS}ms`);
  console.log();
  console.log(`  WITHOUT fix: timer fires at ${TIMEOUT_S * 1000}ms → TimeoutError`);
  console.log(`  WITH fix   : each ping resets deadline → resolves cleanly`);
  console.log();

  let fakeWS!: ReturnType<typeof createFakeWS>;

  const adapter = new ElevenLabsAgentAdapter({
    agentId: "demo-agent-id",
    apiKey: "demo-api-key",
    webSocketFactory: (_url, _headers) => {
      fakeWS = createFakeWS();
      return fakeWS;
    },
  });

  // 1. Connect
  await adapter.connect();
  console.log(`${elapsed()} [adapter] connected`);
  console.log();

  // 2. Arm receiveAudio — idle deadline starts NOW
  console.log(`${elapsed()} [adapter] receiveAudio(${TIMEOUT_S}s) ← idle deadline armed`);
  const receivePromise = adapter.receiveAudio(TIMEOUT_S);

  // 3. Fire pings every PING_INTERVAL_MS — each resets the idle deadline
  for (let i = 1; i <= N_PINGS; i++) {
    await new Promise<void>((r) => setTimeout(r, PING_INTERVAL_MS));
    console.log(
      `${elapsed()} [ws←server] ping #${i}  → deadline reset (+${TIMEOUT_S * 1000}ms from now)`,
    );
    fakeWS.inject(pingEvent(i));
  }

  // 4. Audio arrives — resolves the promise
  await new Promise<void>((r) => setTimeout(r, AUDIO_DELAY_MS));
  console.log(`${elapsed()} [ws←server] audio event (100 bytes PCM16 silence)`);
  fakeWS.inject(audioEvent());

  const chunk = await receivePromise;

  console.log();
  console.log(
    `${elapsed()} [adapter] receiveAudio RESOLVED — chunk.data.length=${chunk.data.length} bytes`,
  );
  console.log();
  console.log("PASS: no premature timeout after " +
    `${N_PINGS * PING_INTERVAL_MS}ms of server silence kept alive by pings.`);

  await adapter.disconnect();
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\nFAILED: ${msg}`);
  process.exit(1);
});
