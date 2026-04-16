# Voice testing over Twilio

Scenario can exercise real phone calls via Twilio Media Streams in two roles:

| Role | Direction | Method | Who owns the agent-under-test |
|------|-----------|--------|-------------------------------|
| Scenario answers calls | **answer** | `wait_for_call()` | Scenario (when you want the adapter itself as the test target) |
| Scenario places calls  | **call**   | `place_call(to=...)` | External (your prod agent, a human, another Twilio number) |

Same class, same state — a Twilio number can both answer and originate, and
the adapter mirrors that. The first of `wait_for_call()` / `place_call()`
that fires fixes the mode for the lifetime of that session; switching after
the fact raises. See [`specs/voice-agents.feature`](../specs/voice-agents.feature)
for the adapter contract.

**Caller-mode adapters leave the Twilio account untouched.** `place_call` uses
the TwiML URL passed to `calls.create()` directly; the number's inbound
webhook is never overwritten. This is what makes it safe to test a prod
agent without disturbing its deployment — see "Testing a prod voice agent"
below.

## Testing a prod voice agent

Your agent is wired to a Twilio number in prod (say `+1-555-YOUR-AGENT`).
You want scenario to bench it without touching its webhook, its deployment,
or its code. Buy one Twilio number for scenario (`+1-555-SCENARIO`) and:

```python
import asyncio
import scenario
from scenario.voice.testing import TwilioHarness

async def main() -> None:
    async with TwilioHarness(
        account_sid=...,
        auth_token=...,
        phone_number="+15555CENARIO",   # scenario's own number (the caller)
    ) as caller:
        await caller.place_call(to="+15555YOURAGENT")   # dials your prod agent
        result = await scenario.run(
            name="prod agent handles a return",
            description="Customer wants to return a defective product.",
            agents=[
                caller,
                scenario.UserSimulatorAgent(),
                scenario.JudgeAgent(criteria=["agent identifies the issue"]),
            ],
        )
        print(result)

asyncio.run(main())
```

Scenario's number dials your prod agent as a simulated customer. The prod
agent answers its phone as it always does. Your deployment is untouched; no
webhook swap, no staging stack, no pipecat sidecar.

## Prerequisites

### 1. cloudflared (for smoke tests only)

Twilio needs a public HTTPS URL to reach your machine. Scenario's
`TwilioHarness` spins up a cloudflared "quick tunnel" per run — no account,
no DNS, ephemeral `*.trycloudflare.com` hostname.

```sh
# macOS
brew install cloudflared

# Linux — follow the official installer (apt repo needs to be added first):
# https://developers.cloudflare.com/cloudflared/install/
```

Verify: `cloudflared --version` should print a version string.

### 2. Twilio account

Sign up at https://www.twilio.com/try-twilio. Trial accounts get ~$15 free
credit and can keep one number.

From the console (https://console.twilio.com):
1. **Account SID + Auth Token** — top-right "Account Info" panel. SID starts
   with `AC`.
2. **Phone number** — Console → Phone Numbers → Manage → Buy a Number. Make
   sure it has **Voice** capability. The number is in E.164 format
   (`+14155551234`).

### 3. Python .env

```
# python/.env
OPENAI_API_KEY=sk-...
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+14155551234
```

### Trial account restriction

**Outbound calls to non-verified numbers fail on trial accounts.** Before
running the `simulator_calls_human` smoke, add your own cell to the
Verified Caller IDs:

Console → Phone Numbers → Manage → **Verified Caller IDs** → Add a Number →
enter your cell → enter the verification code you receive.

Two Twilio numbers on the same trial account can call each other without
verification. Inbound calls have no such restriction either.

## Smoke examples

Each is a runnable script. No pytest markers, no env gates — they just run.
Keys come from `python/.env`.

### Smoke 1 — pipecat bot + PipecatAgentAdapter

Tests the SDK's WebSocket-client-to-pipecat path. Requires a running
pipecat bot (the example bot in `examples/voice_pipecat_twilio_bot.py`).

```sh
# Terminal A — install pipecat, start bot
pip install "pipecat-ai[openai,websockets,runner]"
python examples/voice_pipecat_twilio_bot.py --host 0.0.0.0 --port 8765

# Terminal B — tunnel to expose bot to Twilio
cloudflared tunnel --url http://localhost:8765
# Copy the https://*.trycloudflare.com URL.

# Console → Phone Numbers → Active Numbers → pick your number →
# under Voice Configuration set "A call comes in" to Webhook, URL=<tunnel URL>/, POST.

# Terminal C — run the scenario
python examples/voice_pipecat_scenario.py

# Dial your Twilio number from your phone. The pipecat bot answers.
# Scenario records the conversation through a second WS connection to
# the bot's /stream endpoint and judges it.
```

### Smoke 2 — scenario answers an inbound call

Tests `TwilioAgentAdapter.wait_for_call()`. Scenario IS the agent-under-test;
a human dials in.

```sh
python examples/voice_twilio_agent_answers_scenario.py

# The script spins up a cloudflared tunnel, registers its URL as your
# Twilio number's voice webhook (automatically), then prints:
#   "Dial +1415… within 60s."
# Dial it. Scenario's user-sim greets the caller, short exchange, hang up.
# The script restores your number's prior webhook on exit.
```

### Smoke 3 — scenario dials a human

Tests `TwilioAgentAdapter.place_call()` + `on_dtmf` callback. Requires a
human with a phone. **Deterministic assertion**: user-sim says "Press 1
then hang up"; scenario asserts `on_dtmf("1")` fires within 60s.

```sh
export TARGET_PHONE_NUMBER=+14155557777   # YOUR cell, must be Verified in trial
python examples/voice_twilio_simulator_calls_human_scenario.py

# Your phone rings. Answer, listen for the instruction, press 1, hang up.
# The script exits 0 on success, 1 on timeout.
```

### Automated two-adapter testing (no human, no Twilio)

The in-process loopback at `python/tests/voice/test_twilio_two_adapter_bridge.py`
proves the Media Streams WS frame protocol is symmetric between two
adapters without spending any money — two `TwilioAgentAdapter` instances
are wired together via asyncio queues and a 440 Hz tone round-trips
through µ-law encode → frame → parse → decode.

### Two Twilio numbers calling each other (NOT supported)

A seemingly-obvious smoke is "adapter A places a call to adapter B's
number, both use `<Connect><Stream>`, tones round-trip over PSTN." This
**does not work** with pure Media Streams. `<Connect>` is a terminal
TwiML verb — each leg's audio attaches to its *own* WS endpoint rather
than bridging to the other number. The legs never connect to each other.

Bridging two Twilio numbers with full bidirectional audio AND a WS tap
from scenario requires `<Conference>` (each number joins a named
conference room; scenario joins via a third call). That's a bigger
feature than what's in scope here — tracked as a follow-up issue.

## If a test crashes mid-run

Only `wait_for_call()` (answer mode) modifies the Twilio number's
`voice_url`; `place_call()` (caller mode) leaves it alone. So:

- **Caller-mode crashes** leave no stale state — the number's webhook was
  never touched.
- **Answer-mode crashes** can leave the webhook pointed at a dead
  cloudflared URL. `disconnect()` restores it on normal exit, but a `kill
  -9` or power-off skips that.

To reset manually:

```sh
# Clear the webhook:
python - <<'EOF'
import os
from twilio.rest import Client
from dotenv import load_dotenv
load_dotenv()

client = Client(os.environ["TWILIO_ACCOUNT_SID"], os.environ["TWILIO_AUTH_TOKEN"])
nums = client.incoming_phone_numbers.list(phone_number=os.environ["TWILIO_PHONE_NUMBER"])
nums[0].update(voice_url="")
print(f"Cleared voice_url on {nums[0].phone_number}")
EOF
```

Or click "A call comes in" in the Twilio console and set it back manually.

## Reference

The minimal pipecat bot in `examples/voice_pipecat_twilio_bot.py` is adapted
from [`langwatch/openclaw-phone-assistant`](https://github.com/langwatch/openclaw-phone-assistant)
— that repo is the fuller reference implementation if you want hold music,
transcript syncing, custom tool calls, etc.
