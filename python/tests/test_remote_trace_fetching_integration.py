"""
Integration test for remote trace fetching, end to end through the executor.

Binds the @integration scenario of specs/remote-trace-fetching.feature:
"Remote spans reach the judge prompt through the standard digest".

A fake LangWatch trace API (respx over the real httpx transport) serves a
trace with a tool span for every trace id the scenario stamps on its
messages. The scenario runs to a verdict with ``fetch_remote_traces``
enabled; the only mocked boundary besides the trace API is the judge LLM.
"""

import json
from typing import Any, cast
from unittest.mock import patch

import httpx
import langwatch
import langwatch.state
import pytest
import respx
from litellm import ModelResponse

import scenario
from scenario.agent_adapter import AgentAdapter
from scenario.types import AgentInput, AgentReturnTypes
from scenario._tracing import ensure_tracing_initialized


FAKE_ENDPOINT = "https://fake.langwatch.test"
FAKE_API_KEY = "test-api-key"


class _EchoAgent(AgentAdapter):
    async def call(self, input: AgentInput) -> AgentReturnTypes:
        return {"role": "assistant", "content": "I checked the requirements table."}


def _finish_test_response() -> ModelResponse:
    # A real ModelResponse, not a MagicMock: full runs serialize the LLM
    # response into tracing spans, and a MagicMock hangs the JSON encoder.
    return ModelResponse(
        choices=[
            {
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "tc-1",
                            "type": "function",
                            "function": {
                                "name": "finish_test",
                                "arguments": json.dumps(
                                    {
                                        "verdict": "success",
                                        "reasoning": "verified against traces",
                                        "criteria": {
                                            "agent_queried_the_requirements_table": "true"
                                        },
                                    }
                                ),
                            },
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ]
    )


def _trace_payload(trace_id: str) -> dict:
    return {
        "trace_id": trace_id,
        "spans": [
            {
                "trace_id": trace_id,
                "span_id": "f1e2d3c4b5a69788",
                "name": "query_requirements_table",
                "type": "tool",
                "timestamps": {
                    "started_at": 1721382486895,
                    "finished_at": 1721382488392,
                },
                "input": {"type": "json", "value": {"table": "requirements"}},
                "output": {"type": "text", "value": "4 rows"},
            }
        ],
    }


@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_remote_spans_reach_the_judge_prompt_through_the_standard_digest(
    monkeypatch: pytest.MonkeyPatch,
):
    """@scenario Remote spans reach the judge prompt through the standard digest"""
    # Initialize scenario tracing without credentials so no span exporter is
    # wired anywhere, then set up the langwatch client explicitly with
    # skip_open_telemetry_setup so the fake credentials never create an
    # exporter either; only the trace API fetch and the event posts (both
    # httpx) go through respx.
    monkeypatch.delenv("LANGWATCH_API_KEY", raising=False)
    ensure_tracing_initialized(None)
    monkeypatch.setenv("LANGWATCH_ENDPOINT", FAKE_ENDPOINT)
    monkeypatch.setenv("LANGWATCH_API_KEY", FAKE_API_KEY)
    previous_client = langwatch.state.get_instance()
    langwatch.setup(
        api_key=FAKE_API_KEY,
        endpoint_url=FAKE_ENDPOINT,
        instrumentors=[],
        skip_open_telemetry_setup=True,
    )

    trace_requests: list[httpx.Request] = []

    def serve_trace(request: httpx.Request) -> httpx.Response:
        trace_requests.append(request)
        trace_id = request.url.path.rsplit("/", 1)[-1]
        return httpx.Response(200, json=_trace_payload(trace_id))

    try:
        with respx.mock(assert_all_called=False) as mock_router:
            mock_router.get(url__regex=rf"{FAKE_ENDPOINT}/api/trace/.+").mock(
                side_effect=serve_trace
            )
            mock_router.post(f"{FAKE_ENDPOINT}/api/scenario-events").mock(
                return_value=httpx.Response(200, json={})
            )

            with patch(
                "scenario.judge_agent.litellm.completion",
                return_value=_finish_test_response(),
            ) as completion:
                result = await scenario.arun(
                    name="remote trace integration",
                    description="The user asks what the requirements are",
                    agents=[
                        _EchoAgent(),
                        scenario.UserSimulatorAgent(model="none"),
                        scenario.JudgeAgent(
                            model="openai/gpt-5-mini",
                            criteria=["Agent queried the requirements table"],
                        ),
                    ],
                    script=[
                        scenario.user("What are the requirements?"),
                        scenario.agent(),
                        scenario.judge(),
                    ],
                    fetch_remote_traces=True,
                    trace_wait_timeout=10.0,
                )
    finally:
        langwatch.state.set_instance(cast(Any, previous_client))

    assert result.success

    assert trace_requests, "the judge fetched the trace from the fake API"
    first_request = trace_requests[0]
    assert first_request.headers["Authorization"] == f"Bearer {FAKE_API_KEY}"
    assert first_request.headers["X-Auth-Token"] == FAKE_API_KEY

    judge_messages = completion.call_args.kwargs["messages"]
    user_message = next(m for m in judge_messages if m["role"] == "user")
    content: Any = user_message["content"]
    traces_section = content.split("<opentelemetry_traces>")[1].split(
        "</opentelemetry_traces>"
    )[0]
    assert "query_requirements_table" in traces_section
    assert "requirements" in traces_section
