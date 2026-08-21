"""
E2E check: the realtime mint actually reaches a LangWatch AI Gateway.

Every other proof of routing in this repository is indirect. The voice job
holds no provider key, so a run that reached OpenAI directly could not pass,
and a direct-dial fallback is promoted to a test failure there. Both are real
guarantees, and both are arguments about what did NOT happen.

This asserts what DID. A gateway names the session it opened on the
``X-LangWatch-Session-Id`` response header and the vendor does not, so the
header is the one thing that cannot be told a lie about what answered. The
session id it returns is the id of the spend record the mint opened.

Nothing here opens a media socket. The mint alone is what proves the route,
and the session it books is closed immediately with a zero usage report,
which is the truth for a credential that opened no socket.
"""

from __future__ import annotations

import os
from typing import Optional

import pytest

from scenario.config.voice_models import OPENAI_REALTIME_MODEL
from scenario.voice.broker import (
    OPENAI_DEFAULT_BASE_URL,
    close_unused_realtime_session,
    mint_openai_realtime_session,
    resolve_realtime_mint_endpoint,
)


@pytest.mark.asyncio
async def test_the_realtime_mint_is_answered_by_a_gateway(requires_llm):
    base_url = os.environ.get("OPENAI_BASE_URL", "")
    if not base_url or base_url.rstrip("/") == OPENAI_DEFAULT_BASE_URL:
        pytest.fail(
            "OPENAI_BASE_URL is unset or points at OpenAI, so there is no "
            "gateway to route through and this check cannot mean anything. "
            "Set it to the gateway base URL, for example "
            "https://gateway.langwatch.ai/v1. Missing infrastructure is a "
            "failure here, not a skip."
        )

    endpoint = resolve_realtime_mint_endpoint()
    assert endpoint is not None, (
        "no mint endpoint resolved: OPENAI_API_KEY is empty, so the adapter "
        "would dial the vendor directly instead of minting"
    )

    result = await mint_openai_realtime_session(endpoint, OPENAI_REALTIME_MODEL)

    assert result.minted, (
        f"the mint route at {endpoint.base_url} answered 404, so this base URL "
        "is not a LangWatch gateway and voice is not being metered"
    )

    # Every assertion about the response runs inside the try so the session
    # this mint booked is closed even when one of them fails. Without that, a
    # failing check leaves the record open and holding one of the key's slots
    # until the gateway's grace expires.
    close_error: Optional[Exception] = None
    try:
        assert result.credential.startswith("ek_"), (
            "the mint returned something that is not an OpenAI ephemeral "
            "client secret, so the socket would not authenticate"
        )
        assert result.session_id, (
            "the mint succeeded but carried no X-LangWatch-Session-Id, so "
            "OpenAI answered it directly and no spend record was opened"
        )
        # Printed on purpose: this id is the spend record the mint opened, so
        # a run can be matched to a row in the ledger from its own log.
        print(f"\ngateway spend record for this mint: {result.session_id}\n")
    finally:
        if result.session_id:
            # Close it at zero. Only a report can close a booked session, and
            # a gateway that had not opened a spend record would refuse this
            # with 404, so the report landing is also evidence of the record.
            close_error = await close_unused_realtime_session(
                endpoint, result.session_id
            )

    # Asserted after the finally so a cleanup failure never hides the primary
    # assertion that got us here.
    assert close_error is None, (
        f"the gateway refused the closing usage report: {close_error}"
    )
