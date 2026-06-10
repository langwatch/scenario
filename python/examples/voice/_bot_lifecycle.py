"""
Auto-start the bundled Pipecat stub bot for demo runs.

The CI workflow brings the bot up explicitly (see voice-integration.yml).
For local demo runs, we don't want users to have to remember to launch it
in another tab — so each Pipecat-dependent demo wraps its main() in
``async with ensure_pipecat_bot():``.

Behavior:
- If something is already listening on the bot's port, do nothing — the
  user (or a previous run) is responsible for that bot. We don't take
  ownership and we don't tear it down.
- Otherwise, spawn ``examples/voice/_bot/bot.py`` as a subprocess,
  poll the port until it accepts connections (up to 30s), yield, and on
  exit terminate the subprocess we started.

The function is opt-in per demo so demos that intentionally drive a
different bot (e.g. ``_pipecat_twilio_bot.py``) don't get hijacked.
"""

from __future__ import annotations

import asyncio
import logging
import os
import socket
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

logger = logging.getLogger("voice_bot.lifecycle")

DEFAULT_BOT_HOST = "127.0.0.1"
DEFAULT_BOT_PORT = 8765
DEFAULT_BOT_PATH = Path(__file__).resolve().parent / "_bot" / "bot.py"
READY_TIMEOUT_S = 30.0
POLL_INTERVAL_S = 0.5


def _port_is_open(host: str, port: int, timeout: float = 0.25) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except (OSError, ConnectionRefusedError):
        return False


@asynccontextmanager
async def ensure_pipecat_bot(
    host: str = DEFAULT_BOT_HOST,
    port: int = DEFAULT_BOT_PORT,
    bot_path: Path = DEFAULT_BOT_PATH,
) -> AsyncIterator[None]:
    """Ensure the bundled Pipecat stub bot is reachable for the duration of the block.

    Yields once the bot is ready. Raises RuntimeError if the bot fails to come up
    within READY_TIMEOUT_S. Cleans up only the subprocess we started — never
    touches an already-running bot.
    """
    if _port_is_open(host, port):
        logger.info("Pipecat bot already running on %s:%d — using as-is", host, port)
        yield
        return

    if not bot_path.exists():
        raise RuntimeError(f"Pipecat bot script not found at {bot_path}")

    env = os.environ.copy()
    env.setdefault("BOT_HOST", host)
    env.setdefault("BOT_PORT", str(port))
    # Capture VAD + STT decisions so a failed demo run is debuggable from
    # /tmp/voice-pipecat-bot.log.
    env.setdefault("BOT_LOG_LEVEL", "DEBUG")
    # Force unbuffered stdout/stderr so the log file reflects what happened up
    # to the moment of a crash or timeout. Without this, Python's default
    # block-buffering (8 KB) means the log is near-empty when the bot is
    # killed — exact failure mode from #501.
    env["PYTHONUNBUFFERED"] = "1"

    # Tee bot logs to /tmp/voice-pipecat-bot.log so failed runs are debuggable.
    # Truncate on each spawn — if you need history, grab the file before the
    # next run.
    log_path = Path("/tmp/voice-pipecat-bot.log")
    log_handle = log_path.open("w")
    logger.info("Starting Pipecat bot from %s (log: %s)", bot_path, log_path)
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        str(bot_path),
        env=env,
        stdout=log_handle,
        stderr=log_handle,
    )

    deadline = asyncio.get_running_loop().time() + READY_TIMEOUT_S
    while asyncio.get_running_loop().time() < deadline:
        if _port_is_open(host, port):
            logger.info("Pipecat bot ready on %s:%d (PID %d)", host, port, process.pid)
            break
        await asyncio.sleep(POLL_INTERVAL_S)
    else:
        process.terminate()
        await process.wait()
        raise RuntimeError(
            f"Pipecat bot did not become ready on {host}:{port} within {READY_TIMEOUT_S}s"
        )

    try:
        yield
    finally:
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
            logger.info("Pipecat bot stopped")
        log_handle.close()
