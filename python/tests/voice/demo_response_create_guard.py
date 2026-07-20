#!/usr/bin/env python3
"""
Live demo: response.create double-fire guard — PR #669

Exercises the PRODUCTION OpenAIRealtimeAgentAdapter code (not the pytest test
suite) to show the guard preventing a duplicate response.create while a response
is already in flight.

No OpenAI API key required. A logging WS stub captures all wire traffic so you
can see exactly what the adapter sends and when.

Usage:
    cd python
    python3 tests/voice/demo_response_create_guard.py
"""
import asyncio
import base64
import json
import logging
import sys
from pathlib import Path
from typing import Any, List

# ── import the production adapter ─────────────────────────────────────────────
# Ensures this script is runnable from the python/ directory (cd python &&
# python3 tests/voice/demo_response_create_guard.py) without needing a pip
# install or PYTHONPATH tweak.
_root = Path(__file__).parent.parent.parent  # .../python/
if str(_root) not in sys.path:
    sys.path.insert(0, str(_root))

# Silence third-party noise so the demo output is readable.
logging.basicConfig(level=logging.WARNING, stream=sys.stdout)
logging.getLogger("scenario.voice.openai_realtime").setLevel(logging.DEBUG)

from scenario.voice.adapters.openai_realtime import OpenAIRealtimeAgentAdapter

# ── minimal instrumented WS stub ─────────────────────────────────────────────

class LoggingWS:
    """
    Minimal WebSocket stub — records every send/recv.
    Not pytest infrastructure: no assertions, no fixtures, no marks.
    Exists solely to capture adapter wire traffic for the demo.
    """
    def __init__(self, server_events: List[str]) -> None:
        self._queue = list(server_events)
        self._idx = 0
        self.log: List[tuple] = []   # (direction, type)

    async def send(self, msg: Any) -> None:
        d = json.loads(msg) if isinstance(msg, str) else msg
        t = d.get("type", "?")
        self.log.append(("SEND", t))
        print(f"      → SEND  [{t}]")

    async def recv(self) -> str:
        if self._idx >= len(self._queue):
            await asyncio.sleep(0)
            raise asyncio.TimeoutError("stub: no more server events")
        evt = self._queue[self._idx]
        self._idx += 1
        t = json.loads(evt).get("type", "?")
        self.log.append(("RECV", t))
        print(f"      ← RECV  [{t}]")
        return evt

    async def close(self) -> None:
        pass

    def sent_types(self) -> List[str]:
        return [t for (d, t) in self.log if d == "SEND"]

    def ordered_log(self) -> List[str]:
        return [f"{d:4s}  {t}" for (d, t) in self.log]

    def first_log_idx(self, direction: str, etype: str) -> int:
        for i, (d, t) in enumerate(self.log):
            if d == direction and t == etype:
                return i
        return -1


# ── helpers ──────────────────────────────────────────────────────────────────

def hr(title: str) -> None:
    print(f"\n{'─'*62}")
    print(f"  {title}")
    print(f"{'─'*62}\n")


def make_pcm_b64(samples: int = 480) -> str:
    return base64.b64encode(b"\x00\x00" * samples).decode()


# ── Scenario A: guard suppresses double response.create ──────────────────────

async def scenario_a() -> bool:
    hr("SCENARIO A — Guard suppresses duplicate response.create")
    print("  Context: user audio arrives while a response is already streaming.\n"
          "  Before fix: recv_audio() fires response.create unconditionally →\n"
          "              server rejects with 'Conversation already has an active\n"
          "              response in progress'.\n"
          "  After fix:  recv_audio() detects _response_active=True and DEFERS.\n")

    stub = LoggingWS([
        json.dumps({"type": "response.created"}),
    ])

    adapter = OpenAIRealtimeAgentAdapter(speaks_first=False)
    adapter._ws = stub

    # Inject race condition: a response is already in flight
    adapter._response_active = True
    adapter._pending_audio_bytes = 960   # 480 samples × 2 bytes PCM16

    print("  Initial state:")
    print(f"    _response_active       = {adapter._response_active}")
    print(f"    _pending_audio_bytes   = {adapter._pending_audio_bytes}")
    print(f"    _deferred_response_create = {adapter._deferred_response_create}\n")
    print("  Calling recv_audio(timeout=0.1) ...\n")

    try:
        await adapter.recv_audio(timeout=0.1)
    except (asyncio.TimeoutError, RuntimeError):
        pass  # expected — no audio delta in queue

    print()
    print("  State after recv_audio:")
    print(f"    _deferred_response_create = {adapter._deferred_response_create}")
    print()
    print("  Wire log:")
    for entry in stub.ordered_log():
        print(f"    {entry}")

    guard_ok = "response.create" not in stub.sent_types()
    deferred_ok = adapter._deferred_response_create is True

    print()
    print("  RESULT:")
    print(f"    response.create suppressed?  {'YES ✓' if guard_ok else 'NO  ✗  (BUG)'}")
    print(f"    _deferred_response_create?   {'YES ✓' if deferred_ok else 'NO  ✗  (BUG)'}")

    return guard_ok and deferred_ok


# ── Scenario B: deferred create fires after response.done ───────────────────

async def scenario_b() -> bool:
    hr("SCENARIO B — Deferred response.create fires after response.done")
    print("  Context: the in-flight response completes (response.done) while the\n"
          "  deferral flag is set. The handler must fire response.create exactly\n"
          "  once, strictly AFTER response.done in the event log.\n")

    chunk = make_pcm_b64()
    stub = LoggingWS([
        json.dumps({"type": "response.done"}),           # in-flight ends
        json.dumps({"type": "response.created"}),         # deferred create ACK
        json.dumps({"type": "response.output_audio.delta", "delta": chunk}),
        json.dumps({"type": "response.done"}),            # deferred response ends
    ])

    adapter = OpenAIRealtimeAgentAdapter(speaks_first=False)
    adapter._ws = stub

    adapter._response_active = True
    adapter._response_ever_active = True
    adapter._pending_audio_bytes = 960

    print("  Initial state:")
    print(f"    _response_active       = {adapter._response_active}")
    print(f"    _pending_audio_bytes   = {adapter._pending_audio_bytes}")
    print(f"    _deferred_response_create = {adapter._deferred_response_create}\n")
    print("  Calling recv_audio(timeout=2.0) ...\n")

    result = await adapter.recv_audio(timeout=2.0)

    print()
    print("  Wire log (chronological):")
    for entry in stub.ordered_log():
        print(f"    {entry}")

    sent = stub.sent_types()
    commit_count = sent.count("input_audio_buffer.commit")
    create_count = sent.count("response.create")

    log_create = stub.first_log_idx("SEND", "response.create")
    log_done   = stub.first_log_idx("RECV", "response.done")
    ordered_ok = log_done >= 0 and log_create > log_done
    audio_ok   = result is not None and isinstance(result.data, bytes) and len(result.data) > 0

    print()
    print("  RESULT:")
    print(f"    input_audio_buffer.commit count = {commit_count}  (expected 1) {'✓' if commit_count==1 else '✗'}")
    print(f"    response.create count           = {create_count}  (expected 1) {'✓' if create_count==1 else '✗'}")
    print(f"    response.create after done?     = {'YES ✓' if ordered_ok else 'NO  ✗  (BUG)'}")
    print(f"      (log index create={log_create}, done={log_done})")
    print(f"    audio chunk received?           = {'YES ✓' if audio_ok else 'NO  ✗'}")
    print(f"      ({len(result.data)} bytes)" if result else "      (None)")

    return commit_count == 1 and create_count == 1 and ordered_ok and audio_ok


# ── Scenario C: send_text guard ──────────────────────────────────────────────

async def scenario_c() -> bool:
    hr("SCENARIO C — send_text guard (issue #662)")
    print("  Context: send_text() is called while a response is in flight.\n"
          "  Before fix: send_text fires response.create immediately → duplicate.\n"
          "  After fix:  send_text sets _deferred_response_create=True instead.\n")

    stub = LoggingWS([])   # send_text does not call recv — no server events needed

    adapter = OpenAIRealtimeAgentAdapter(speaks_first=False)
    adapter._ws = stub
    adapter._response_active = True

    print("  Initial state:")
    print(f"    _response_active          = {adapter._response_active}")
    print(f"    _deferred_response_create = {adapter._deferred_response_create}\n")
    print("  Calling send_text('Hello, tell me about yourself') ...\n")

    await adapter.send_text("Hello, tell me about yourself")

    print()
    print("  Wire log:")
    if stub.log:
        for entry in stub.ordered_log():
            print(f"    {entry}")
    else:
        print("    (no wire events — response.create was suppressed)")

    sent = stub.sent_types()
    guard_ok   = "response.create" not in sent
    deferred_ok = adapter._deferred_response_create is True
    item_ok    = "conversation.item.create" in sent

    print()
    print("  RESULT:")
    print(f"    response.create suppressed?      {'YES ✓' if guard_ok else 'NO  ✗  (BUG)'}")
    print(f"    _deferred_response_create?       {'YES ✓' if deferred_ok else 'NO  ✗  (BUG)'}")
    print(f"    conversation.item.create sent?   {'YES ✓' if item_ok else 'NO  ✗'}")

    return guard_ok and deferred_ok and item_ok


# ── main ─────────────────────────────────────────────────────────────────────

async def main() -> None:
    print()
    print("=" * 62)
    print("  response.create double-fire guard — LIVE DEMO")
    print("  PR #669  langwatch/scenario")
    print("  Production adapter code + instrumented WS stub")
    print("=" * 62)

    results = {
        "A: recv_audio guard (response active)": await scenario_a(),
        "B: deferred create fires after done":    await scenario_b(),
        "C: send_text guard (issue #662)":        await scenario_c(),
    }

    hr("SUMMARY")
    all_pass = all(results.values())
    for label, ok in results.items():
        print(f"  {'✓' if ok else '✗'}  {label}")
    print()
    if all_pass:
        print("  ALL SCENARIOS PASS — guard is operating correctly.")
        print("  No double response.create can be sent in any guarded path.")
    else:
        print("  FAILURES DETECTED — see above for details.")
    print()
    sys.exit(0 if all_pass else 1)


if __name__ == "__main__":
    asyncio.run(main())
