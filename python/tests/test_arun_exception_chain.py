"""The exception raised by ``scenario.arun`` must preserve the user's
original frame in its traceback so debugging is straightforward.

Scenario wraps adapter failures in
``raise RuntimeError(f"[{agent_name}] {e}") from e`` — the ``from e``
is what keeps the user's ``__cause__`` alive. If any code path strips
it (e.g. a new exception created without chaining), users lose the
line number of the actual bug.
"""

from __future__ import annotations

import os
import traceback

import pytest

os.environ.setdefault("SCENARIO_HEADLESS", "true")

import scenario
from scenario.agent_adapter import AgentAdapter
from scenario.types import AgentInput, AgentReturnTypes, AgentRole, ScenarioResult


class _BadAgent(AgentAdapter):
    async def call(self, input: AgentInput) -> AgentReturnTypes:
        # _divide_by_zero always raises; the return is unreachable but
        # required so the type checker sees a valid AgentReturnTypes path.
        _divide_by_zero()
        return {"role": "assistant", "content": "unreachable"}


def _divide_by_zero() -> None:
    _ = 1 / 0  # SENTINEL user frame


class _User(AgentAdapter):
    role = AgentRole.USER

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return "hi"


class _Judge(AgentAdapter):
    role = AgentRole.JUDGE

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return ScenarioResult(
            success=True, messages=[], reasoning="ok", passed_criteria=["t"]
        )


@pytest.mark.asyncio
async def test_user_traceback_survives_arun():
    try:
        await scenario.arun(
            name="bad",
            description="adapter raises ZeroDivisionError",
            agents=[_BadAgent(), _User(), _Judge()],
            script=[
                scenario.user("hi"),
                scenario.agent(),
                scenario.judge(),
            ],
        )
    except Exception as e:
        tb = traceback.format_exc()
        assert "_divide_by_zero" in tb, (
            f"expected user frame _divide_by_zero in traceback; got: {tb}"
        )
        assert e.__cause__ is not None, (
            "Exception chain broken — the underlying ZeroDivisionError "
            "must remain accessible via __cause__ for debuggers."
        )
        assert isinstance(e.__cause__, ZeroDivisionError)
    else:  # pragma: no cover
        pytest.fail("arun did not raise, but the adapter did")


class _TimeoutAgent(AgentAdapter):
    """Raises a no-args TimeoutError, reproducing the blank-body bug."""

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        raise TimeoutError()


@pytest.mark.asyncio
async def test_no_args_exception_includes_type_name_in_message():
    """RuntimeError body must never be blank for no-args exceptions.

    Regression for #500: ``str(TimeoutError())`` returns ``""`` so the old
    ``f"[{agent_name}] {e}"`` produced ``"[_TimeoutAgent] "`` — unreadable.
    The fix uses ``type(e).__name__`` as a fallback so the body always names
    the exception kind.
    """
    try:
        await scenario.arun(
            name="timeout",
            description="adapter raises bare TimeoutError()",
            agents=[_TimeoutAgent(), _User(), _Judge()],
            script=[
                scenario.user("hi"),
                scenario.agent(),
                scenario.judge(),
            ],
        )
    except RuntimeError as e:
        msg = str(e)
        assert msg.strip(), f"RuntimeError body must not be blank; got: {msg!r}"
        assert "TimeoutError" in msg, (
            f"expected exception type name in message; got: {msg!r}"
        )
        assert e.__cause__ is not None
        assert isinstance(e.__cause__, TimeoutError)
    else:  # pragma: no cover
        pytest.fail("arun did not raise, but the adapter did")
