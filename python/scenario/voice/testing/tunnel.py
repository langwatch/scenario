"""
Code-managed cloudflared "quick tunnel" for local webhook+WebSocket testing.

Spawns ``cloudflared tunnel --url http://localhost:PORT`` as a subprocess,
parses stdout for the ``*.trycloudflare.com`` hostname, yields it as the
public URL, tears down on exit.

No cloudflared account required (quick tunnels are ephemeral).

Usage:

    async with CloudflareTunnel(port=8080) as tunnel:
        print(tunnel.public_url)   # e.g. https://foo-bar.trycloudflare.com
        # ... point Twilio webhook at this URL, run scenario ...
"""

from __future__ import annotations

import asyncio
import logging
import re
import shutil
import signal
from typing import Optional


logger = logging.getLogger("scenario.voice.testing.tunnel")


_INSTALL_INSTRUCTIONS = (
    "cloudflared is required for TwilioAgentAdapter smoke tests. Install:\n"
    "  macOS: brew install cloudflared\n"
    "  Linux: https://developers.cloudflare.com/cloudflared/install/"
)

# Matches the trycloudflare URL emitted on stdout/stderr during tunnel startup.
_TRYCLOUDFLARE_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


class TunnelUnavailableError(RuntimeError):
    """Raised when cloudflared is missing or the tunnel URL never appears."""


class CloudflareTunnel:
    """
    Async context manager that spawns a cloudflared quick tunnel and yields
    its public URL.

    The public URL is available as ``self.public_url`` after ``__aenter__``.
    """

    def __init__(self, port: int, *, startup_timeout_s: float = 20.0) -> None:
        self.port = port
        self.startup_timeout_s = startup_timeout_s
        self.public_url: Optional[str] = None
        self._proc: Optional[asyncio.subprocess.Process] = None

    async def __aenter__(self) -> "CloudflareTunnel":
        if shutil.which("cloudflared") is None:
            raise TunnelUnavailableError(_INSTALL_INSTRUCTIONS)

        self._proc = await asyncio.create_subprocess_exec(
            "cloudflared",
            "tunnel",
            "--url",
            f"http://localhost:{self.port}",
            "--no-autoupdate",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

        try:
            self.public_url = await asyncio.wait_for(
                self._read_url(), timeout=self.startup_timeout_s
            )
        except asyncio.TimeoutError:
            await self._terminate()
            raise TunnelUnavailableError(
                f"cloudflared did not announce a trycloudflare.com URL within "
                f"{self.startup_timeout_s}s. Check `cloudflared` output for errors."
            )

        logger.debug("cloudflared quick tunnel live at %s → localhost:%d", self.public_url, self.port)
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self._terminate()

    async def _read_url(self) -> str:
        assert self._proc is not None and self._proc.stdout is not None
        while True:
            line_bytes = await self._proc.stdout.readline()
            if not line_bytes:
                raise TunnelUnavailableError(
                    "cloudflared exited before announcing a tunnel URL."
                )
            line = line_bytes.decode("utf-8", errors="replace")
            match = _TRYCLOUDFLARE_RE.search(line)
            if match:
                return match.group(0)

    async def _terminate(self) -> None:
        if self._proc is None or self._proc.returncode is not None:
            return
        try:
            self._proc.send_signal(signal.SIGTERM)
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=3.0)
            except asyncio.TimeoutError:
                logger.debug("cloudflared did not exit on SIGTERM; sending SIGKILL")
                self._proc.kill()
                await self._proc.wait()
        except ProcessLookupError:
            pass
        finally:
            self._proc = None
