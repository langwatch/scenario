"""
Unit tests for CloudflareTunnel — error paths only. The real tunnel spawn
is exercised in examples/voice/twilio_{inbound,outbound}.py (manual).
"""

from unittest.mock import patch

import pytest

from scenario.voice.testing import CloudflareTunnel, TunnelUnavailableError


@pytest.mark.asyncio
async def test_missing_cloudflared_raises_with_install_instructions():
    with patch("scenario.voice.testing.tunnel.shutil.which", return_value=None):
        tunnel = CloudflareTunnel(port=8080)
        with pytest.raises(TunnelUnavailableError) as exc_info:
            await tunnel.__aenter__()
    msg = str(exc_info.value)
    assert "brew install cloudflared" in msg
    assert "developers.cloudflare.com" in msg
