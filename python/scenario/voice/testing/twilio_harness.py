"""
Twilio smoke-test harness: compose CloudflareTunnel + TwilioAgentAdapter
setup/teardown into one async context manager.

Usage::

    from scenario.voice import TwilioAgentAdapter
    from scenario.voice.testing import TwilioHarness

    async with TwilioHarness(
        account_sid=..., auth_token=..., phone_number="+1415...",
        on_dtmf=lambda d: print("got DTMF", d),
    ) as adapter:
        # adapter is a connected TwilioAgentAdapter
        await adapter.wait_for_call(timeout=30)
        # ... scenario.run(...) here ...

The harness:
    1. Spawns ``cloudflared tunnel --url http://localhost:PORT``
    2. Constructs ``TwilioAgentAdapter(public_base_url=<tunnel_url>)``
    3. Calls ``adapter.connect()`` (which registers the webhook and starts
       the FastAPI server)
    4. On exit: ``adapter.disconnect()`` then tunnel teardown.

This is the one blessed way to run the adapter locally without manually
managing a tunnel + webhook + server.
"""

from __future__ import annotations

import logging
from typing import Callable, Optional

from ..adapters.twilio import TwilioAgentAdapter
from .tunnel import CloudflareTunnel


logger = logging.getLogger("scenario.voice.testing.twilio_harness")


class TwilioHarness:
    """
    Async context manager yielding a connected ``TwilioAgentAdapter``.

    The adapter's ``public_base_url`` is set from the cloudflared quick
    tunnel URL — no DNS or account setup required.
    """

    def __init__(
        self,
        *,
        account_sid: str,
        auth_token: str,
        phone_number: str,
        http_port: int = 8765,
        allowed_callers: Optional[list[str]] = None,
        on_dtmf: Optional[Callable[[str], None]] = None,
        validate_signature: bool = True,
    ) -> None:
        self._account_sid = account_sid
        self._auth_token = auth_token
        self._phone_number = phone_number
        self._http_port = http_port
        self._allowed_callers = allowed_callers
        self._on_dtmf = on_dtmf
        self._validate_signature = validate_signature

        self._tunnel: Optional[CloudflareTunnel] = None
        self._adapter: Optional[TwilioAgentAdapter] = None

    async def __aenter__(self) -> TwilioAgentAdapter:
        self._tunnel = CloudflareTunnel(port=self._http_port)
        await self._tunnel.__aenter__()

        assert self._tunnel.public_url is not None
        self._adapter = TwilioAgentAdapter(
            account_sid=self._account_sid,
            auth_token=self._auth_token,
            phone_number=self._phone_number,
            public_base_url=self._tunnel.public_url,
            allowed_callers=self._allowed_callers,
            on_dtmf=self._on_dtmf,
            http_port=self._http_port,
            validate_signature=self._validate_signature,
        )
        try:
            await self._adapter.connect()
            # Now that the FastAPI server is bound on localhost, wait for the
            # Cloudflare edge to actually route inbound traffic to it. This
            # prevents the "Twilio fetched TwiML too early, got a 502, dropped
            # the call with duration=0" race that otherwise bites callers
            # placing outbound calls immediately after harness startup.
            await self._tunnel.wait_until_edge_reachable()
        except Exception:
            if self._adapter is not None:
                try:
                    await self._adapter.disconnect()
                except Exception:
                    # Startup-path cleanup is best-effort; a secondary
                    # disconnect error must not mask the original failure
                    # we're about to re-raise.
                    logger.exception("TwilioHarness: adapter.disconnect() during aborted startup raised")
            await self._tunnel.__aexit__(None, None, None)
            self._tunnel = None
            self._adapter = None
            raise

        # Don't leak full E.164 number into the workflow log (CI retains
        # for 14 days). Reuse the adapter's redactor — last-4 is enough
        # to identify which test number is in use.
        from ..adapters._twilio_shared import _redact_e164

        logger.info(
            "TwilioHarness ready — tunnel %s → localhost:%d, number %s",
            self._tunnel.public_url,
            self._http_port,
            _redact_e164(self._phone_number),
        )
        return self._adapter

    async def __aexit__(self, exc_type, exc, tb) -> None:
        # Adapter disconnect first (restores webhook), then tunnel teardown.
        if self._adapter is not None:
            try:
                await self._adapter.disconnect()
            except Exception:
                logger.exception("TwilioHarness: adapter.disconnect() raised")
        if self._tunnel is not None:
            try:
                await self._tunnel.__aexit__(exc_type, exc, tb)
            except Exception:
                logger.exception("TwilioHarness: tunnel teardown raised")
        self._adapter = None
        self._tunnel = None
