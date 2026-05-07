"""
Minimal pipecat voice bot — the system-under-test for PipecatAgentAdapter.

This is the ONLY file in the scenario repo that imports pipecat.

Runs a FastAPI server with a Twilio Media Streams WebSocket endpoint.
Configure your Twilio number's voice webhook to POST here, and incoming
calls will be handled by OpenAI Realtime via the pipecat pipeline.

Usage:
    pip install "pipecat-ai[openai,websockets,runner]"
    python examples/voice/_pipecat_twilio_bot.py --host 0.0.0.0 --port 8765

Prerequisites:
    - OPENAI_API_KEY in python/.env (loaded by this script)
    - Twilio webhook pointing at <public-url>/ (a cloudflared tunnel works)

Adapted from https://github.com/langwatch/openclaw-phone-assistant (stripped
of OpenClaw-specific integrations). Lean version for scenario's smoke test.
"""

import argparse
import os
import sys
from pathlib import Path


# Load python/.env — scenario's convention for provider keys.
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")
except ImportError:
    pass  # python-dotenv is a scenario dep; if missing, env must be set another way

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    sys.exit("Error: OPENAI_API_KEY is required. Set in python/.env or environment.")

from scenario.config.voice_models import OPENAI_REALTIME_MODEL as DEFAULT_OPENAI_REALTIME_MODEL

try:
    from fastapi import FastAPI, Request, WebSocket
    from fastapi.responses import Response
except ImportError:
    sys.exit(
        "Error: fastapi is required. Install with: pip install fastapi uvicorn"
    )

try:
    from pipecat.frames.frames import LLMRunFrame
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.pipeline.task import PipelineParams, PipelineTask
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import (
        LLMContextAggregatorPair,
    )
    from pipecat.serializers.twilio import TwilioFrameSerializer
    from pipecat.services.openai.realtime.events import (
        AudioConfiguration,
        AudioInput,
        AudioOutput,
        InputAudioTranscription,
        SessionProperties,
        TurnDetection,
    )
    from pipecat.services.openai.realtime.llm import OpenAIRealtimeLLMService
    from pipecat.transports.websocket.fastapi import (
        FastAPIWebsocketParams,
        FastAPIWebsocketTransport,
    )
except ImportError:
    sys.exit(
        "Error: pipecat is required. Install with:\n"
        '  pip install "pipecat-ai[openai,websockets,runner]"'
    )


# ----------------------------------------------------------- agent pipeline


SYSTEM_PROMPT = """\
You are a friendly voice assistant on a phone call. Keep responses short (1–2
sentences) because this is a real-time voice conversation. If the caller asks
you to do something specific ('press 1', 'hang up', 'say X'), follow their
request naturally. Acknowledge DTMF input if mentioned.
"""


async def run_pipeline_for_call(
    websocket: WebSocket, *, stream_sid: str, call_sid: str
) -> None:
    """Run one pipecat pipeline per inbound call."""
    serializer = TwilioFrameSerializer(
        stream_sid=stream_sid,
        call_sid=call_sid,
        auto_hang_up=False,  # scenario decides when to hang up
    )

    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            serializer=serializer,
        ),
    )

    session_properties = SessionProperties(
        instructions=SYSTEM_PROMPT,
        tool_choice="auto",
        audio=AudioConfiguration(
            input=AudioInput(
                transcription=InputAudioTranscription(),
                turn_detection=TurnDetection(
                    threshold=0.85,
                    prefix_padding_ms=500,
                    silence_duration_ms=1200,
                ),
            ),
            output=AudioOutput(voice="alloy"),
        ),
    )

    llm = OpenAIRealtimeLLMService(
        api_key=OPENAI_API_KEY,
        model=os.environ.get("OPENAI_REALTIME_MODEL", DEFAULT_OPENAI_REALTIME_MODEL),
        session_properties=session_properties,
    )

    context = LLMContext(
        messages=[{"role": "user", "content": "Say hi and ask how you can help."}],
    )
    aggregator = LLMContextAggregatorPair(context)

    pipeline = Pipeline(
        [
            transport.input(),
            aggregator.user(),
            llm,
            transport.output(),
            aggregator.assistant(),
        ]
    )

    task = PipelineTask(pipeline, PipelineParams(audio_in_sample_rate=8000))
    runner = PipelineRunner(handle_sigint=False)

    await task.queue_frame(LLMRunFrame())
    await runner.run(task)


# ----------------------------------------------------------- FastAPI app


def build_app() -> FastAPI:
    app = FastAPI(title="scenario-voice-pipecat-bot")

    @app.post("/")
    async def voice_webhook(request: Request) -> Response:
        """Twilio hits this when a call comes in. Returns TwiML pointing at our WS."""
        host = request.headers.get("host", "localhost")
        # Twilio needs WSS for TLS; http hosts get ws. cloudflared gives https.
        proto = "wss" if request.url.scheme == "https" else "ws"
        stream_url = f"{proto}://{host}/stream"
        twiml = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            "<Response>"
            f'<Connect><Stream url="{stream_url}"/></Connect>'
            "</Response>"
        )
        return Response(content=twiml, media_type="application/xml")

    @app.websocket("/stream")
    async def media_stream(ws: WebSocket) -> None:
        await ws.accept()
        # Twilio sends `connected` + `start` messages before the first `media`.
        # Parse them to get stream/call SIDs for the serializer.
        import json

        stream_sid = "MZ_unknown"
        call_sid = "CA_unknown"

        # Grab first few frames until we see `start`.
        for _ in range(5):
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if data.get("event") == "start":
                stream_sid = data.get("streamSid") or data.get("start", {}).get("streamSid") or stream_sid
                call_sid = data.get("start", {}).get("callSid") or call_sid
                break

        try:
            await run_pipeline_for_call(ws, stream_sid=stream_sid, call_sid=call_sid)
        except Exception as exc:
            # Log and let the WS close; scenario-side adapter will surface it.
            print(f"bot: pipeline error: {exc!r}", file=sys.stderr)

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="Minimal pipecat voice bot for scenario smokes.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="Bind port (default: 8765)")
    args = parser.parse_args()

    try:
        import uvicorn
    except ImportError:
        sys.exit("Error: uvicorn is required. Install with: pip install uvicorn")

    print(f"bot: serving on http://{args.host}:{args.port}")
    print(f"bot: Twilio webhook → http://<tunnel-host>/")
    print(f"bot: Media Streams WS → ws://<tunnel-host>/stream")
    uvicorn.run(build_app(), host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
