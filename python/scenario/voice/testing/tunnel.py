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

import httpx


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

    def __init__(
        self,
        port: int,
        *,
        startup_timeout_s: float = 20.0,
        # 300s accommodates slow Cloudflare quick-tunnel DNS propagation
        # (trycloudflare.com has no SLA; propagation can exceed 2 minutes).
        edge_ready_timeout_s: float = 300.0,
    ) -> None:
        self.port = port
        self.startup_timeout_s = startup_timeout_s
        self.edge_ready_timeout_s = edge_ready_timeout_s
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

        logger.debug("cloudflared quick tunnel announced %s → localhost:%d", self.public_url, self.port)
        return self

    async def wait_until_edge_reachable(self, *, timeout_s: Optional[float] = None) -> None:
        """Poll until the tunnel URL is globally reachable.

        Cloudflared announces the URL as soon as its side connects to
        Cloudflare's network, but DNS + edge caching can take additional
        seconds before the URL is actually reachable from the public
        internet. Without this wait, Twilio's TwiML fetch races and
        silently fails (call completed, duration 0, no notification).

        Resolution strategy: race multiple resolvers, return on the first
        one that says "this host resolves." Empirically, both
        Cloudflare DoH and the system resolver have been observed to
        lag the other on freshly-minted trycloudflare hostnames; either
        can be authoritative on a given day. We need ANY resolver to
        say yes, because Twilio's edge will hit one of these paths too.

        Resolvers tried each tick:
        - Cloudflare DoH (1.1.1.1) — historically the canonical signal.
        - Google DoH (dns.google) — backup public resolver.
        - System getaddrinfo — what local DNS sees; fastest when
          Cloudflare DoH is the laggard (observed 2026-05-13).

        Caller is responsible for starting the local HTTP server *before*
        calling this — otherwise the HTTP probe sees 502 from Cloudflare
        (origin down). When used via ``TwilioHarness``, the harness
        wires this correctly.
        """
        assert self.public_url is not None
        deadline = asyncio.get_running_loop().time() + (timeout_s or self.edge_ready_timeout_s)
        last_error: Optional[str] = None
        host = self.public_url.replace("https://", "").replace("http://", "").rstrip("/").split("/")[0]

        async def _via_doh(client: httpx.AsyncClient, url: str) -> Optional[str]:
            r = await client.get(
                url,
                params={"name": host, "type": "A"},
                headers={"accept": "application/dns-json"},
            )
            data = r.json()
            if data.get("Status") == 0 and data.get("Answer"):
                return data["Answer"][0].get("data")
            return None

        async def _via_system() -> Optional[str]:
            try:
                infos = await asyncio.get_running_loop().getaddrinfo(
                    host, None, family=0, type=0, proto=0, flags=0
                )
                if infos:
                    return infos[0][4][0]
                return None
            except Exception:
                return None

        async with httpx.AsyncClient(timeout=5.0) as doh_client:
            while asyncio.get_running_loop().time() < deadline:
                # Race three resolvers — succeed if ANY say "resolved" within this tick.
                tasks = [
                    asyncio.create_task(_via_doh(doh_client, "https://cloudflare-dns.com/dns-query")),
                    asyncio.create_task(_via_doh(doh_client, "https://dns.google/resolve")),
                    asyncio.create_task(_via_system()),
                ]
                # Wait for ALL to complete (or timeout) — fast resolvers
                # returning None must not cause us to give up before slower
                # resolvers (which may have the answer) finish.
                done, pending = await asyncio.wait(tasks, return_when=asyncio.ALL_COMPLETED, timeout=5.0)
                resolved_ip: Optional[str] = None
                fail_reasons: list[str] = []
                for t in done:
                    try:
                        result = t.result()
                        if result:
                            resolved_ip = result
                            break
                        fail_reasons.append("no answer")
                    except Exception as e:
                        fail_reasons.append(f"{type(e).__name__}: {e}")
                for p in pending:
                    p.cancel()
                if resolved_ip:
                    logger.debug(
                        "cloudflared tunnel %s resolves globally (A=%s)",
                        host, resolved_ip,
                    )
                    return
                last_error = ", ".join(fail_reasons) or "no resolver responded"
                await asyncio.sleep(1.0)

        raise TunnelUnavailableError(
            f"cloudflared tunnel {self.public_url} did not become globally "
            f"resolvable within {timeout_s or self.edge_ready_timeout_s}s. "
            f"last_error={last_error}"
        )

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
            # Process already exited between the returncode check above and
            # our send_signal; nothing to clean up.
            pass
        finally:
            self._proc = None
