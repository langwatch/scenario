# Voice testing over Twilio

Scenario can exercise real phone calls via Twilio Media Streams in two roles:

| Role | Direction | Adapter class | Method |
|------|-----------|---------------|--------|
| Agent-under-test answers calls | **inbound** | `TwilioAgentAdapter` | `wait_for_call()` |
| Scenario places calls | **outbound** | `TwilioAgentAdapter` | `place_call(to=...)` |

Same class, same state — a Twilio number can both answer and originate, and
the adapter mirrors that. See
[`specs/voice-agents.feature`](../specs/voice-agents.feature) for the adapter
contract and [`python/scenario/voice/adapters/twilio.py`](../python/scenario/voice/adapters/twilio.py)
for the full surface.

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
2. **Phone number** — Console → Phone Numbers → Manage → Buy a Number (US
   numbers are $1.15/mo). Make sure it has **Voice** capability. The number
   is in E.164 format (`+14155551234`).

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
running the outbound smoke, add your own cell to the Verified Caller IDs:

Console → Phone Numbers → Manage → **Verified Caller IDs** → Add a Number →
enter your cell → enter the verification code you receive.

Inbound calls have no such restriction — anyone can dial your Twilio number.

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

### Smoke 2 — inbound, scenario answers directly

Tests `TwilioAgentAdapter.wait_for_call()`. No pipecat. Scenario IS the
system-under-test.

```sh
python examples/voice_twilio_inbound_scenario.py

# The script spins up a cloudflared tunnel, registers its URL as your
# Twilio number's voice webhook (automatically), then prints:
#   "Dial +1415… within 60s."
# Dial it. Scenario's user-sim greets the caller, short exchange, hang up.
```

### Smoke 3 — outbound, scenario dials YOU

Tests `TwilioAgentAdapter.place_call()` + `on_dtmf` callback.
**Deterministic assertion**: user-sim says "Press 1 then hang up";
scenario asserts `on_dtmf("1")` fires within 60s.

```sh
export TARGET_PHONE_NUMBER=+14155557777   # YOUR cell, must be Verified in trial
python examples/voice_twilio_outbound_scenario.py

# Your phone rings. Answer, listen for the instruction, press 1, hang up.
# The script exits 0 on success, 1 on timeout.
```

## If a test crashes mid-run

Scenario registers the tunnel URL as the Twilio number's `voice_url` at
`connect()` and restores the prior value at `disconnect()`. If the process
is killed, the webhook stays pointed at a dead cloudflared URL, and
incoming calls fail.

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
