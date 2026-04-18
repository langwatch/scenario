"""Integration test: a shared Google ADK ``InMemoryRunner`` works across
concurrent ``scenario.arun`` invocations.

This is the exact failure mode the customer hit: the ADK runner
instantiated in a pytest fixture holds a gRPC channel / session service
bound to the caller's event loop, and scenario's thread-pool worker
executes the adapter on a *different* loop, which tripped "Future
attached to a different loop". With ``scenario.arun`` the adapter runs
on the caller's loop, so the singleton stays usable.

Requires ``GOOGLE_API_KEY`` and ``google-adk``. Skipped otherwise.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from typing import List

import pytest

os.environ.setdefault("SCENARIO_HEADLESS", "true")

import scenario
from scenario.agent_adapter import AgentAdapter
from scenario.types import AgentInput, AgentReturnTypes, AgentRole, ScenarioResult


def _has_adk() -> bool:
    try:
        import google.adk  # noqa: F401  # pyright: ignore[reportMissingImports]
        from google.adk.agents import Agent  # noqa: F401  # pyright: ignore[reportMissingImports]
        from google.adk.runners import InMemoryRunner  # noqa: F401  # pyright: ignore[reportMissingImports]
    except Exception:
        return False
    return True


pytestmark = [
    pytest.mark.skipif(not _has_adk(), reason="google-adk not installed"),
    pytest.mark.skipif(
        not os.environ.get("GOOGLE_API_KEY"), reason="GOOGLE_API_KEY not set"
    ),
]


# Sometimes the test environment has old google-genai / ADK combos where
# ``InMemoryRunner`` cannot be constructed. Skip rather than fail loudly.
def _build_runner():
    from google.adk.agents import Agent  # pyright: ignore[reportMissingImports]
    from google.adk.runners import InMemoryRunner  # pyright: ignore[reportMissingImports]

    def get_weather(city: str) -> dict:
        return {"status": "ok", "report": f"Sunny in {city}"}

    agent = Agent(
        name="weather_agent",
        model=os.environ.get("GEMINI_MODEL", "gemini-flash-latest"),
        description="Replies with a short weather report.",
        instruction="Call get_weather for the city the user asks about and answer briefly.",
        tools=[get_weather],
    )
    return InMemoryRunner(agent=agent, app_name="scenario-arun-adk-integration")


@pytest.fixture(scope="module")
def shared_runner():
    # Created once per module on the event loop that pytest-asyncio is
    # driving — this is the loop all concurrent scenarios must reuse.
    try:
        yield _build_runner()
    except Exception as exc:  # pragma: no cover - env-dependent
        pytest.skip(f"Failed to build ADK runner: {exc}")


class _ADKAgent(AgentAdapter):
    """Forwards the latest user message through a shared ADK runner.

    The ``InMemoryRunner`` is constructed outside the adapter and passed
    in — ``arun`` must await on it using the same loop it was built on.
    """

    def __init__(self, runner, session_prefix: str, observed: List[dict]):
        self._runner = runner
        self._session_prefix = session_prefix
        self._observed = observed
        self._session_idx = 0

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        from google.genai import types  # pyright: ignore[reportMissingImports]

        last_user = next(
            (m for m in reversed(input.messages) if m.get("role") == "user"),
            None,
        )
        raw = (last_user or {}).get("content") or "Hello"
        text = raw if isinstance(raw, str) else "Hello"

        session_id = f"{self._session_prefix}-{self._session_idx}"
        self._session_idx += 1
        await self._runner.session_service.create_session(
            app_name="scenario-arun-adk-integration",
            user_id="user",
            session_id=session_id,
        )

        reply = "(no reply)"
        # Drain the full event stream before returning — early-returning
        # leaves the async generator for the event loop to GC in a
        # different context, which tripped ADK's OTel context-detach
        # assertion on langwatch's experiment path.
        async for event in self._runner.run_async(
            user_id="user",
            session_id=session_id,
            new_message=types.Content(role="user", parts=[types.Part(text=text)]),
        ):
            if not event.is_final_response():
                continue
            content = getattr(event, "content", None)
            parts = getattr(content, "parts", None) or []
            txt = getattr(parts[0], "text", None) if parts else None
            if txt:
                reply = txt.strip()

        self._observed.append({"loop_id": id(asyncio.get_running_loop())})
        return {"role": "assistant", "content": reply}


class _StubUser(AgentAdapter):
    role = AgentRole.USER

    def __init__(self, prompt: str):
        self._prompt = prompt

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return self._prompt


class _InstantJudge(AgentAdapter):
    role = AgentRole.JUDGE

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return ScenarioResult(
            success=True,
            messages=[],
            reasoning="adk reply received",
            passed_criteria=["adk responded"],
        )


@pytest.mark.asyncio
async def test_shared_adk_runner_survives_concurrent_arun(shared_runner):
    observed: List[dict] = []
    cities = ["Amsterdam", "Berlin", "Cairo", "Delhi"]
    suffix = uuid.uuid4().hex[:6]

    async def one(city: str, idx: int):
        return await scenario.arun(
            name=f"adk-weather-{city.lower()}",
            description=f"User asks about {city} weather",
            agents=[
                _ADKAgent(shared_runner, f"arun-{suffix}-{idx}", observed),
                _StubUser(f"What is the weather in {city}?"),
                _InstantJudge(),
            ],
            script=[
                scenario.user(f"What is the weather in {city}?"),
                scenario.agent(),
                scenario.judge(),
            ],
        )

    results = await asyncio.gather(
        *(one(city, i) for i, city in enumerate(cities)),
        return_exceptions=True,
    )

    # Any loop-affinity breakage would surface as one of these turning
    # into a RuntimeError with "different loop" in its repr.
    for idx, result in enumerate(results):
        assert not isinstance(result, Exception), (
            f"scenario {idx} raised: {result!r}\n"
            "This likely means the ADK runner was awaited on a loop "
            "it was not created on (i.e. arun regressed to scenario.run's "
            "threaded behaviour)."
        )

    assert all(isinstance(r, ScenarioResult) and r.success for r in results)

    # All adapter invocations must have run on a single event loop — the
    # one this test function itself is running on.
    loop_ids = {o["loop_id"] for o in observed}
    assert loop_ids == {id(asyncio.get_running_loop())}
