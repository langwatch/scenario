"""Tests for the hardening applied to JudgeAgent's force-verdict path.

The force-verdict path must:
  - Collapse prior expand_trace/grep_trace tool_call/tool_result pairs into
    plain-text assistant recaps so Anthropic does not reject the call for
    referencing tools that are being stripped.
  - Strip expand_trace/grep_trace from the tool set on the forced call so
    the model physically cannot leak a discovery tool back.
  - Degrade a leaked discovery tool to an inconclusive ScenarioResult
    instead of raising, as a last line of defense.
"""

import json
from types import SimpleNamespace
from unittest.mock import patch

from scenario import JudgeAgent
from scenario.judge_agent import (
    _DISCOVERY_TOOL_NAMES,
    _collapse_discovery_history,
)
from scenario.types import ScenarioResult


def _make_tool_call(call_id: str, name: str, args: dict) -> dict:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(args)},
    }


def _mock_llm_response(tool_name: str, args: dict, call_id: str = "tc-final"):
    tc = SimpleNamespace(
        id=call_id,
        type="function",
        function=SimpleNamespace(name=tool_name, arguments=json.dumps(args)),
    )
    message = SimpleNamespace(tool_calls=[tc], content=None)
    choice = SimpleNamespace(message=message)
    return SimpleNamespace(choices=[choice])


class TestCollapseDiscoveryHistory:
    def test_rewrites_discovery_cycles_into_plain_text(self):
        messages = [
            {"role": "system", "content": "system prompt"},
            {"role": "user", "content": "evaluate this"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    _make_tool_call(
                        "tc-1", "expand_trace", {"span_ids": ["deadbeef"]}
                    )
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "tc-1",
                "content": "span details body",
            },
        ]

        out = _collapse_discovery_history(messages)

        assert len(out) == 3  # system, user, single recap assistant
        assert out[0]["role"] == "system"
        assert out[1]["role"] == "user"
        assert out[2]["role"] == "assistant"
        assert isinstance(out[2]["content"], str)
        assert "expand_trace" in out[2]["content"]
        assert "span details body" in out[2]["content"]
        # No tool_calls and no tool-role messages remain.
        assert "tool_calls" not in out[2]
        assert not any(m.get("role") == "tool" for m in out)

    def test_non_discovery_messages_pass_through(self):
        messages = [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello"},
        ]
        assert _collapse_discovery_history(messages) == messages

    def test_mixed_discovery_and_non_discovery_tool_calls(self):
        """Discovery calls are collapsed to text; non-discovery calls and their
        tool results are preserved so their references stay valid in the stripped
        tool set."""
        messages = [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    _make_tool_call("tc-grep", "grep_trace", {"pattern": "error"}),
                    _make_tool_call("tc-ct", "continue_test", {}),
                ],
            },
            {"role": "tool", "tool_call_id": "tc-grep", "content": "grep result"},
            {"role": "tool", "tool_call_id": "tc-ct", "content": ""},
        ]

        out = _collapse_discovery_history(messages)

        # assistant message + tool result for continue_test only
        assert len(out) == 2
        assert out[0]["role"] == "assistant"
        # grep_trace recapped as text
        assert "grep_trace" in (out[0].get("content") or "")
        assert "grep result" in (out[0].get("content") or "")
        # continue_test preserved as a tool_call
        remaining_calls = out[0].get("tool_calls", [])
        assert len(remaining_calls) == 1
        assert remaining_calls[0]["function"]["name"] == "continue_test"
        # tool result for continue_test kept, tool result for grep_trace dropped
        assert out[1]["role"] == "tool"
        assert out[1]["tool_call_id"] == "tc-ct"
        assert not any(m.get("tool_call_id") == "tc-grep" for m in out)


class TestForceVerdictHardening:
    def test_strips_discovery_tools_and_rewrites_history(self):
        agent = JudgeAgent(
            criteria=["Agent works"],
            model="openai/gpt-5-mini",
            max_discovery_steps=2,
        )

        tools = [
            {"type": "function", "function": {"name": "expand_trace"}},
            {"type": "function", "function": {"name": "grep_trace"}},
            {"type": "function", "function": {"name": "continue_test"}},
            {"type": "function", "function": {"name": "finish_test"}},
        ]
        messages = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "judge"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    _make_tool_call(
                        "tc-d1", "expand_trace", {"span_ids": ["aa"]}
                    )
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "tc-d1",
                "content": "discovery result",
            },
        ]

        captured: dict = {}

        def fake_completion(**kwargs):
            captured.update(kwargs)
            return _mock_llm_response(
                "finish_test",
                {
                    "criteria": {"agent_works": "true"},
                    "reasoning": "ok",
                    "verdict": "success",
                },
            )

        with patch("scenario.judge_agent.litellm.completion", side_effect=fake_completion):
            result = agent._force_verdict(
                messages=messages,
                tools=tools,
                effective_criteria=["Agent works"],
                input_messages=[],
            )

        assert isinstance(result, ScenarioResult)
        assert result.success is True

        # Discovery tools must not be passed on the forced call.
        forced_tool_names = {
            t["function"]["name"] for t in captured["tools"]
        }
        assert _DISCOVERY_TOOL_NAMES.isdisjoint(forced_tool_names)
        assert "finish_test" in forced_tool_names

        # Message history must be rewritten: no tool role, no tool_calls on
        # assistant messages, and the discovery output must survive as text.
        forced_messages = captured["messages"]
        assert all(m.get("role") != "tool" for m in forced_messages)
        assert all(
            "tool_calls" not in m for m in forced_messages
            if m.get("role") == "assistant"
        )
        recap_hit = any(
            m.get("role") == "assistant"
            and "expand_trace" in (m.get("content") or "")
            and "discovery result" in (m.get("content") or "")
            for m in forced_messages
        )
        assert recap_hit

        # tool_choice forces finish_test.
        assert captured["tool_choice"] == {
            "type": "function",
            "function": {"name": "finish_test"},
        }


class TestParseResponseSafetyNet:
    def test_leaked_discovery_tool_returns_inconclusive_not_exception(self):
        agent = JudgeAgent(criteria=["A", "B"], model="openai/gpt-5-mini")
        leaked = _mock_llm_response(
            "expand_trace", {"span_ids": ["xx"]}, call_id="tc-leak"
        )

        result = agent._parse_response(leaked, ["A", "B"], messages=[], input_messages=[])

        assert isinstance(result, ScenarioResult)
        assert result.success is False
        assert result.reasoning is not None
        assert "did not converge" in result.reasoning
        assert set(result.failed_criteria) == {"A", "B"}
        assert result.passed_criteria == []
