"""@scenario Scenario run fails fast when the agent returns no content (issue #1033).

Helper unit tests plus executor-level tests. Fakes only, no LLM calls.
"""

from __future__ import annotations

import os
from typing import List

import pytest

os.environ.setdefault("SCENARIO_HEADLESS", "true")

import scenario
from scenario.agent_adapter import AgentAdapter
from scenario.types import AgentInput, AgentReturnTypes, AgentRole, ScenarioResult


def is_empty_agent_turn(messages):
    # Imported lazily so the executor tests report their own failures
    # instead of one collection error while the helper does not exist yet.
    from scenario._utils.utils import is_empty_agent_turn as helper

    return helper(messages)


# --------------------------------------------------------------------------
# Helper: is_empty_agent_turn
# --------------------------------------------------------------------------


class TestGivenMessagesWithNoContent:
    def test_no_messages_is_empty(self):
        assert is_empty_agent_turn([]) is True

    def test_empty_string_content_is_empty(self):
        assert is_empty_agent_turn([{"role": "assistant", "content": ""}]) is True

    def test_whitespace_content_is_empty(self):
        assert is_empty_agent_turn([{"role": "assistant", "content": " \n\t "}]) is True

    def test_none_content_is_empty(self):
        assert is_empty_agent_turn([{"role": "assistant", "content": None}]) is True

    def test_missing_content_is_empty(self):
        assert is_empty_agent_turn([{"role": "assistant"}]) is True

    def test_empty_content_list_is_empty(self):
        assert is_empty_agent_turn([{"role": "assistant", "content": []}]) is True

    def test_blank_text_parts_are_empty(self):
        message = {
            "role": "assistant",
            "content": [
                {"type": "text", "text": ""},
                {"type": "text", "text": "  "},
            ],
        }
        assert is_empty_agent_turn([message]) is True

    def test_several_empty_messages_are_empty(self):
        messages = [
            {"role": "assistant", "content": ""},
            {"role": "assistant", "content": None},
        ]
        assert is_empty_agent_turn(messages) is True

    def test_empty_tool_calls_list_with_empty_content_is_empty(self):
        message = {"role": "assistant", "content": "", "tool_calls": []}
        assert is_empty_agent_turn([message]) is True

    def test_none_tool_calls_with_blank_content_is_empty(self):
        message = {"role": "assistant", "content": " ", "tool_calls": None}
        assert is_empty_agent_turn([message]) is True


class TestGivenMessagesWithContent:
    def test_text_content_is_not_empty(self):
        assert is_empty_agent_turn([{"role": "assistant", "content": "hi"}]) is False

    def test_dash_reply_is_not_empty(self):
        assert is_empty_agent_turn([{"role": "assistant", "content": "-"}]) is False

    def test_tool_calls_with_empty_content_is_not_empty(self):
        message = {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "lookup", "arguments": "{}"},
                }
            ],
        }
        assert is_empty_agent_turn([message]) is False

    @pytest.mark.parametrize(
        "field",
        [
            {"audio": {"id": "a1", "data": "AAAA"}},
            {"refusal": "I cannot help with that"},
            {"function_call": {"name": "lookup", "arguments": "{}"}},
        ],
        ids=["audio", "refusal", "function-call"],
    )
    def test_message_level_field_with_empty_content_is_not_empty(self, field):
        message = {"role": "assistant", "content": None, **field}
        assert is_empty_agent_turn([message]) is False

    def test_function_role_message_is_not_empty(self):
        message = {"role": "function", "name": "lookup", "content": ""}
        assert is_empty_agent_turn([message]) is False

    def test_tool_message_is_not_empty(self):
        message = {"role": "tool", "tool_call_id": "call_1", "content": ""}
        assert is_empty_agent_turn([message]) is False

    @pytest.mark.parametrize(
        "part",
        [
            {"type": "refusal", "refusal": "no"},
            {"type": "file", "file": {"file_data": "AAAA", "filename": "a.pdf"}},
            {"type": "reasoning", "text": "thinking"},
            {"type": "tool_use", "id": "t1", "name": "x", "input": {}},
            {"type": "tool_result", "tool_use_id": "t1", "content": ""},
        ],
        ids=["refusal", "file", "reasoning", "tool-call", "tool-result"],
    )
    def test_other_non_text_part_is_not_empty(self, part):
        assert is_empty_agent_turn([{"role": "assistant", "content": [part]}]) is False

    def test_text_part_with_text_is_not_empty(self):
        message = {
            "role": "assistant",
            "content": [{"type": "text", "text": "hello"}],
        }
        assert is_empty_agent_turn([message]) is False

    def test_audio_part_is_not_empty(self):
        message = {
            "role": "assistant",
            "content": [{"type": "input_audio", "input_audio": {"data": "AAAA", "format": "wav"}}],
        }
        assert is_empty_agent_turn([message]) is False

    def test_image_part_is_not_empty(self):
        message = {
            "role": "assistant",
            "content": [{"type": "image_url", "image_url": {"url": "http://x/y.png"}}],
        }
        assert is_empty_agent_turn([message]) is False

    def test_one_empty_next_to_one_with_text_is_not_empty(self):
        messages = [
            {"role": "assistant", "content": ""},
            {"role": "assistant", "content": "hi"},
        ]
        assert is_empty_agent_turn(messages) is False


# --------------------------------------------------------------------------
# Executor level
# --------------------------------------------------------------------------


class _Calls:
    def __init__(self) -> None:
        self.user = 0
        self.judge = 0


class _ReplyAgent(AgentAdapter):
    """Agent under test returning scripted replies, one per turn."""

    def __init__(self, replies: List[AgentReturnTypes]) -> None:
        self._replies = replies
        self.calls = 0

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        reply = self._replies[min(self.calls, len(self._replies) - 1)]
        self.calls += 1
        return reply


class _UserSim(AgentAdapter):
    role = AgentRole.USER

    def __init__(self, calls: _Calls, reply: str = "hi") -> None:
        self._calls = calls
        self._reply = reply

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        self._calls.user += 1
        return self._reply


class _Judge(AgentAdapter):
    role = AgentRole.JUDGE

    def __init__(self, calls: _Calls) -> None:
        self._calls = calls

    async def call(self, input: AgentInput) -> AgentReturnTypes:
        # Like a real judge in the proceed loop: no verdict unless one is requested.
        if input.judgment_request is None:
            return []
        self._calls.judge += 1
        return ScenarioResult(
            success=True, messages=[], reasoning="ok", passed_criteria=["t"]
        )


async def _run(agent: AgentAdapter, calls: _Calls, user_reply: str = "hi", turns: int = 3):
    return await scenario.arun(
        name="empty agent reply",
        description="agent under test returns an empty reply",
        agents=[agent, _UserSim(calls, user_reply), _Judge(calls)],
        script=[scenario.proceed(turns=turns), scenario.judge()],
    )


EMPTY_REPLIES = [
    pytest.param("", id="empty-string"),
    pytest.param("   ", id="whitespace"),
    pytest.param([], id="empty-list"),
    pytest.param({"role": "assistant", "content": None}, id="none-content"),
    pytest.param({"role": "assistant", "content": ""}, id="empty-dict-content"),
]


@pytest.mark.asyncio
class TestGivenAgentReturnsNoContent:
    @pytest.mark.parametrize("reply", EMPTY_REPLIES)
    async def test_run_raises_no_content_error_for_turn_1(self, reply):
        with pytest.raises(RuntimeError, match="agent returned no content on turn 1"):
            await _run(_ReplyAgent([reply]), _Calls())

    async def test_user_simulator_called_once_and_judge_never(self):
        # One reply shape is enough: the check is shape-independent past the helper.
        calls = _Calls()
        with pytest.raises(RuntimeError):
            await _run(_ReplyAgent([""]), calls)
        assert (calls.user, calls.judge) == (1, 0)

    async def test_error_names_the_agent_class(self):
        with pytest.raises(RuntimeError, match=r"\[_ReplyAgent\] agent returned no content"):
            await _run(_ReplyAgent([""]), _Calls())

    async def test_turn_number_is_the_current_turn(self):
        agent = _ReplyAgent(["hello", ""])
        with pytest.raises(RuntimeError, match="agent returned no content on turn 2"):
            await _run(agent, _Calls())


@pytest.mark.asyncio
class TestGivenAgentReturnsNone:
    async def test_none_return_still_fails_via_the_existing_return_type_check(self):
        # Guards the existing check_valid_return_type rejection: None never
        # reaches the no-content check, but the run must keep failing fast.
        calls = _Calls()
        with pytest.raises(RuntimeError):
            await _run(_ReplyAgent([None]), calls)  # type: ignore[list-item]
        assert calls.judge == 0


@pytest.mark.asyncio
class TestGivenAgentReturnsShortOrToolOnlyContent:
    async def test_dash_reply_continues_to_the_judge(self):
        calls = _Calls()
        result = await _run(_ReplyAgent(["-"]), calls)
        assert result.success is True and calls.judge == 1

    async def test_tool_call_with_empty_content_does_not_raise(self):
        reply = {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "lookup", "arguments": "{}"},
                }
            ],
        }
        calls = _Calls()
        result = await _run(_ReplyAgent([reply]), calls)
        assert result.success is True and calls.judge == 1


@pytest.mark.asyncio
class TestGivenUserSimulatorReturnsEmpty:
    async def test_run_completes_without_the_agent_no_content_error(self):
        # The check is for the agent under test only: an empty user turn
        # keeps its existing handling and the run reaches the judge.
        calls = _Calls()
        result = await _run(_ReplyAgent(["hello"]), calls, user_reply="")
        assert result.success is True and calls.judge == 1


@pytest.mark.asyncio
class TestGivenEmptyTurnIsRejected:
    async def test_empty_turn_is_not_added_to_state_messages(self):
        holder: list = []
        calls = _Calls()
        with pytest.raises(RuntimeError):
            await scenario.arun(
                name="empty not stored",
                description="empty agent turn stays out of state",
                agents=[_ReplyAgent([""]), _UserSim(calls), _Judge(calls)],
                script=[
                    lambda state: holder.append(state),
                    scenario.proceed(turns=2),
                ],
            )
        assert [m for m in holder[0].messages if m["role"] == "assistant"] == []


@pytest.mark.asyncio
class TestGivenChecksDoNotApply:
    async def test_scenario_result_return_is_not_flagged(self):
        calls = _Calls()
        result_return = ScenarioResult(
            success=True, messages=[], reasoning="ok", passed_criteria=["t"]
        )
        result = await _run(_ReplyAgent([result_return]), calls)
        assert result.success is True

    async def test_scripted_agent_step_with_blank_text_is_not_flagged(self):
        calls = _Calls()
        result = await scenario.arun(
            name="scripted agent",
            description="scripted agent step supplies the message",
            agents=[_ReplyAgent(["x"]), _UserSim(calls), _Judge(calls)],
            script=[
                scenario.user("hi"),
                scenario.agent({"role": "assistant", "content": ""}),
                scenario.judge(),
            ],
        )
        assert result.success is True and calls.judge == 1

    async def test_voice_adapter_returning_nothing_is_not_flagged(self):
        from scenario.voice.adapter import VoiceAgentAdapter

        class _SilentVoiceAgent(VoiceAgentAdapter):
            """Voice adapter whose turn yields no messages; transport is stubbed."""

            async def connect(self) -> None:
                pass

            async def disconnect(self) -> None:
                pass

            async def send_audio(self, chunk) -> None:
                pass

            async def recv_audio(self, timeout: float):
                raise NotImplementedError

            async def call(self, input: AgentInput) -> AgentReturnTypes:
                return ""

        calls = _Calls()
        result = await _run(_SilentVoiceAgent(), calls, turns=1)
        assert result.success is True and calls.judge == 1
