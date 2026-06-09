"""Tests for judge discovery exhaustion: forces verdict instead of hard-failing.

Reproduces a bug where the judge exhausted 10 discovery steps on a large
agent trace and returned a hard failure with all criteria marked as failed,
instead of rendering a verdict with accumulated context.

The trace mimics Arryon's Nance agent: nested invocations, agent_run spans,
call_llm spans, tool executions (ask_user_question, create_or_update_task,
transfer_to_agent, upsert_workflow), and multi-agent handoff.
"""

import json
import logging
from typing import Any, cast
from unittest.mock import MagicMock, patch

import pytest
from dotenv import load_dotenv
from scenario import JudgeAgent
from scenario._judge.judge_span_digest_formatter import JudgeSpanDigestFormatter
from scenario._tracing.judge_span_collector import JudgeSpanCollector
from scenario.cache import context_scenario
from scenario.config import ScenarioConfig
from scenario.types import AgentInput, ScenarioResult

from tests.helpers.create_span import create_mock_span

load_dotenv()

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Trace fixture: mimics Arryon's Nance orchestrator agent
# ---------------------------------------------------------------------------

def create_nance_agent_trace() -> list:
    """Creates a trace mimicking the Nance orchestrator agent.

    Structure (mirrors Arryon's real trace):
      Scenario Turn
        NanceAgentAdapter.call  (1.8 min)
          invocation [nance_scenario_test]
            agent_run [Nance]
              call_llm
              execute_tool ask_user_question
              llm
          invocation [nance_scenario_test]
            agent_run [Nance]
              execute_tool ask_user_question
              call_llm
              execute_tool ask_user_question
              llm
          invocation [nance_scenario_test]
            agent_run [Nance]
              execute_tool ask_user_question
              call_llm
              execute_tool create_or_update_task
              llm
          invocation [nance_scenario_test]
            agent_run [Nance]
              execute_tool create_or_update_task
              call_llm
              execute_tool create_or_update_task
              llm
          invocation [nance_scenario_test]
            agent_run [Nance]
              execute_tool create_or_update_task
              call_llm
              execute_tool transfer_to_agent
              agent_run [workflow_manager_agent]
                call_llm
                execute_tool ask_user_question
                llm
          invocation [nance_scenario_test]
            agent_run [workflow_manager_agent]
              execute_tool ask_user_question
              call_llm
              execute_tool upsert_workflow
              llm
          invocation [nance_scenario_test]
            agent_run [workflow_manager_agent]
              execute_tool upsert_workflow
              call_llm
            agent_run [Nance]
              call_llm
    """
    base = 1700000000_000_000_000
    spans = []

    def _s(offset_ms, duration_ms):
        return base + offset_ms * 1_000_000, base + (offset_ms + duration_ms) * 1_000_000

    # Root: NanceAgentAdapter.call
    s, e = _s(0, 108_000)
    spans.append(create_mock_span(
        span_id=0x0100000000000000, name="NanceAgentAdapter.call",
        start_time=s, end_time=e,
        attributes={"agent.name": "nance", "agent.framework": "custom"},
    ))

    # --- Invocation 1: Nance asks user question ---
    s, e = _s(100, 12_000)
    spans.append(create_mock_span(
        span_id=0x0200000000000000, name="invocation [nance_scenario_test]",
        start_time=s, end_time=e, parent_span_id=0x0100000000000000,
    ))
    s, e = _s(110, 11_900)
    spans.append(create_mock_span(
        span_id=0x0210000000000000, name="agent_run [Nance]",
        start_time=s, end_time=e, parent_span_id=0x0200000000000000,
    ))
    s, e = _s(120, 6_800)
    spans.append(create_mock_span(
        span_id=0x0211000000000000, name="call_llm",
        start_time=s, end_time=e, parent_span_id=0x0210000000000000,
        attributes={
            "gen_ai.usage.input_tokens": 14437,
            "gen_ai.usage.output_tokens": 512,
            "gen_ai.request.model": "gpt-4",
            "gen_ai.response.text": "I'd be happy to help you set up a weekly workflow! Let me ask a few clarifying questions first. What email address should the expense summary be sent to?",
        },
    ))
    s, e = _s(6_930, 2)
    spans.append(create_mock_span(
        span_id=0x0212000000000000, name="execute_tool ask_user_question",
        start_time=s, end_time=e, parent_span_id=0x0210000000000000,
        attributes={
            "tool.name": "ask_user_question",
            "tool.parameters": json.dumps({"question": "What email address should the expense summary be sent to?"}),
            "tool.status": "success",
        },
    ))
    s, e = _s(6_940, 821)
    spans.append(create_mock_span(
        span_id=0x0213000000000000, name="llm",
        start_time=s, end_time=e, parent_span_id=0x0210000000000000,
        attributes={"gen_ai.usage.input_tokens": 365, "gen_ai.usage.output_tokens": 42},
    ))

    # --- Invocation 2: more clarifying questions ---
    s, e = _s(12_200, 4_100)
    spans.append(create_mock_span(
        span_id=0x0300000000000000, name="invocation [nance_scenario_test]",
        start_time=s, end_time=e, parent_span_id=0x0100000000000000,
    ))
    s, e = _s(12_210, 4_090)
    spans.append(create_mock_span(
        span_id=0x0310000000000000, name="agent_run [Nance]",
        start_time=s, end_time=e, parent_span_id=0x0300000000000000,
    ))
    s, e = _s(12_211, 1)
    spans.append(create_mock_span(
        span_id=0x0311000000000000, name="execute_tool ask_user_question",
        start_time=s, end_time=e, parent_span_id=0x0310000000000000,
        attributes={
            "tool.name": "ask_user_question",
            "tool.parameters": json.dumps({"question": "Where are the expenses stored? (e.g., Google Sheet URL)"}),
            "tool.status": "success",
        },
    ))
    s, e = _s(12_220, 4_000)
    spans.append(create_mock_span(
        span_id=0x0312000000000000, name="call_llm",
        start_time=s, end_time=e, parent_span_id=0x0310000000000000,
        attributes={
            "gen_ai.usage.input_tokens": 14538,
            "gen_ai.usage.output_tokens": 487,
            "gen_ai.request.model": "gpt-4",
            "gen_ai.response.text": "Great, send it to cfo@company.com. Now, which Google Sheet contains the expense data?",
        },
    ))
    s, e = _s(16_225, 0)
    spans.append(create_mock_span(
        span_id=0x0313000000000000, name="execute_tool ask_user_question",
        start_time=s, end_time=e, parent_span_id=0x0310000000000000,
        attributes={
            "tool.name": "ask_user_question",
            "tool.parameters": json.dumps({"question": "Which Google Sheet contains the expense data?"}),
            "tool.status": "success",
        },
    ))
    s, e = _s(16_230, 2_700)
    spans.append(create_mock_span(
        span_id=0x0314000000000000, name="llm",
        start_time=s, end_time=e, parent_span_id=0x0310000000000000,
        attributes={"gen_ai.usage.input_tokens": 328, "gen_ai.usage.output_tokens": 55},
    ))

    # --- Invocation 3: creates task ---
    s, e = _s(16_400, 15_000)
    spans.append(create_mock_span(
        span_id=0x0400000000000000, name="invocation [nance_scenario_test]",
        start_time=s, end_time=e, parent_span_id=0x0100000000000000,
    ))
    s, e = _s(16_410, 14_990)
    spans.append(create_mock_span(
        span_id=0x0410000000000000, name="agent_run [Nance]",
        start_time=s, end_time=e, parent_span_id=0x0400000000000000,
    ))
    s, e = _s(16_411, 1)
    spans.append(create_mock_span(
        span_id=0x0411000000000000, name="execute_tool ask_user_question",
        start_time=s, end_time=e, parent_span_id=0x0410000000000000,
        attributes={
            "tool.name": "ask_user_question",
            "tool.parameters": json.dumps({"question": "Got it. Let me create a task plan for your weekly expense workflow."}),
            "tool.status": "success",
        },
    ))
    s, e = _s(16_420, 14_800)
    spans.append(create_mock_span(
        span_id=0x0412000000000000, name="call_llm",
        start_time=s, end_time=e, parent_span_id=0x0410000000000000,
        attributes={
            "gen_ai.usage.input_tokens": 15770,
            "gen_ai.usage.output_tokens": 890,
            "gen_ai.request.model": "gpt-4",
            "gen_ai.response.text": "I'll create a structured task plan for this weekly expense workflow. Let me set up the task with all the steps.",
        },
    ))
    s, e = _s(31_230, 71)
    spans.append(create_mock_span(
        span_id=0x0413000000000000, name="execute_tool create_or_update_task",
        start_time=s, end_time=e, parent_span_id=0x0410000000000000,
        attributes={
            "tool.name": "create_or_update_task",
            "tool.parameters": json.dumps({
                "title": "Weekly Expense Report Workflow",
                "description": "Automated weekly workflow to pull expenses, summarize, and email to CFO",
                "steps": [
                    "Pull weekly expenses from Google Sheet",
                    "Filter for current week's entries",
                    "Generate summary with totals and transaction details",
                    "Format and send email to cfo@company.com",
                ],
                "schedule": "every Friday at 5:00 PM",
            }),
            "tool.result": json.dumps({"task_id": "task_abc123", "status": "created"}),
            "tool.status": "success",
        },
    ))
    s, e = _s(31_310, 1_400)
    spans.append(create_mock_span(
        span_id=0x0414000000000000, name="llm",
        start_time=s, end_time=e, parent_span_id=0x0410000000000000,
        attributes={"gen_ai.usage.input_tokens": 337, "gen_ai.usage.output_tokens": 65},
    ))

    # --- Invocation 4: more task updates ---
    s, e = _s(31_500, 10_000)
    spans.append(create_mock_span(
        span_id=0x0500000000000000, name="invocation [nance_scenario_test]",
        start_time=s, end_time=e, parent_span_id=0x0100000000000000,
    ))
    s, e = _s(31_510, 9_990)
    spans.append(create_mock_span(
        span_id=0x0510000000000000, name="agent_run [Nance]",
        start_time=s, end_time=e, parent_span_id=0x0500000000000000,
    ))
    s, e = _s(31_520, 56)
    spans.append(create_mock_span(
        span_id=0x0511000000000000, name="execute_tool create_or_update_task",
        start_time=s, end_time=e, parent_span_id=0x0510000000000000,
        attributes={
            "tool.name": "create_or_update_task",
            "tool.parameters": json.dumps({
                "task_id": "task_abc123",
                "status": "in_progress",
                "notes": "Setting up automation steps",
            }),
            "tool.result": json.dumps({"task_id": "task_abc123", "status": "updated"}),
            "tool.status": "success",
        },
    ))
    s, e = _s(31_580, 10_000)
    spans.append(create_mock_span(
        span_id=0x0512000000000000, name="call_llm",
        start_time=s, end_time=e, parent_span_id=0x0510000000000000,
        attributes={
            "gen_ai.usage.input_tokens": 16856,
            "gen_ai.usage.output_tokens": 723,
            "gen_ai.request.model": "gpt-4",
            "gen_ai.response.text": "Now I need to set up the actual automation. Let me transfer this to the workflow manager agent to create the scheduled workflow.",
        },
    ))
    s, e = _s(41_590, 87)
    spans.append(create_mock_span(
        span_id=0x0513000000000000, name="execute_tool create_or_update_task",
        start_time=s, end_time=e, parent_span_id=0x0510000000000000,
        attributes={
            "tool.name": "create_or_update_task",
            "tool.parameters": json.dumps({
                "task_id": "task_abc123",
                "status": "in_progress",
                "notes": "Transferring to workflow manager for automation setup",
            }),
            "tool.result": json.dumps({"task_id": "task_abc123", "status": "updated"}),
            "tool.status": "success",
        },
    ))
    s, e = _s(41_680, 1_400)
    spans.append(create_mock_span(
        span_id=0x0514000000000000, name="llm",
        start_time=s, end_time=e, parent_span_id=0x0510000000000000,
        attributes={"gen_ai.usage.input_tokens": 337, "gen_ai.usage.output_tokens": 48},
    ))

    # --- Invocation 5: transfer to workflow_manager_agent ---
    s, e = _s(43_100, 24_000)
    spans.append(create_mock_span(
        span_id=0x0600000000000000, name="invocation [nance_scenario_test]",
        start_time=s, end_time=e, parent_span_id=0x0100000000000000,
    ))
    s, e = _s(43_110, 23_990)
    spans.append(create_mock_span(
        span_id=0x0610000000000000, name="agent_run [Nance]",
        start_time=s, end_time=e, parent_span_id=0x0600000000000000,
    ))
    s, e = _s(43_120, 14_000)
    spans.append(create_mock_span(
        span_id=0x0611000000000000, name="execute_tool create_or_update_task",
        start_time=s, end_time=e, parent_span_id=0x0610000000000000,
        attributes={
            "tool.name": "create_or_update_task",
            "tool.parameters": json.dumps({
                "task_id": "task_abc123",
                "notes": "Automation setup delegated to workflow_manager_agent",
            }),
            "tool.status": "success",
        },
    ))
    s, e = _s(57_130, 9_800)
    spans.append(create_mock_span(
        span_id=0x0612000000000000, name="call_llm",
        start_time=s, end_time=e, parent_span_id=0x0610000000000000,
        attributes={
            "gen_ai.usage.input_tokens": 18621,
            "gen_ai.usage.output_tokens": 345,
            "gen_ai.request.model": "gpt-4",
        },
    ))
    s, e = _s(66_940, 2)
    spans.append(create_mock_span(
        span_id=0x0613000000000000, name="execute_tool transfer_to_agent",
        start_time=s, end_time=e, parent_span_id=0x0610000000000000,
        attributes={
            "tool.name": "transfer_to_agent",
            "tool.parameters": json.dumps({"agent": "workflow_manager_agent"}),
            "tool.status": "success",
        },
    ))
    # Sub-agent: workflow_manager_agent
    s, e = _s(66_950, 5_800)
    spans.append(create_mock_span(
        span_id=0x0620000000000000, name="agent_run [workflow_manager_agent]",
        start_time=s, end_time=e, parent_span_id=0x0610000000000000,
    ))
    s, e = _s(66_960, 5_790)
    spans.append(create_mock_span(
        span_id=0x0621000000000000, name="call_llm",
        start_time=s, end_time=e, parent_span_id=0x0620000000000000,
        attributes={
            "gen_ai.usage.input_tokens": 13282,
            "gen_ai.usage.output_tokens": 289,
            "gen_ai.request.model": "gpt-4",
            "gen_ai.response.text": "I'll set up the automated workflow. First, what format should the email summary be in?",
        },
    ))
    s, e = _s(72_760, 0)
    spans.append(create_mock_span(
        span_id=0x0622000000000000, name="execute_tool ask_user_question",
        start_time=s, end_time=e, parent_span_id=0x0620000000000000,
        attributes={
            "tool.name": "ask_user_question",
            "tool.parameters": json.dumps({"question": "What format should the email summary be in?"}),
            "tool.status": "success",
        },
    ))
    s, e = _s(72_770, 689)
    spans.append(create_mock_span(
        span_id=0x0623000000000000, name="llm",
        start_time=s, end_time=e, parent_span_id=0x0620000000000000,
        attributes={"gen_ai.usage.input_tokens": 336, "gen_ai.usage.output_tokens": 30},
    ))

    # --- Invocation 6: workflow_manager creates workflow ---
    s, e = _s(73_500, 4_600)
    spans.append(create_mock_span(
        span_id=0x0700000000000000, name="invocation [nance_scenario_test]",
        start_time=s, end_time=e, parent_span_id=0x0100000000000000,
    ))
    s, e = _s(73_510, 4_590)
    spans.append(create_mock_span(
        span_id=0x0710000000000000, name="agent_run [workflow_manager_agent]",
        start_time=s, end_time=e, parent_span_id=0x0700000000000000,
    ))
    s, e = _s(73_511, 0)
    spans.append(create_mock_span(
        span_id=0x0711000000000000, name="execute_tool ask_user_question",
        start_time=s, end_time=e, parent_span_id=0x0710000000000000,
        attributes={
            "tool.name": "ask_user_question",
            "tool.parameters": json.dumps({"question": "Plain HTML email format is fine"}),
            "tool.status": "success",
        },
    ))
    s, e = _s(73_520, 4_500)
    spans.append(create_mock_span(
        span_id=0x0712000000000000, name="call_llm",
        start_time=s, end_time=e, parent_span_id=0x0710000000000000,
        attributes={
            "gen_ai.usage.input_tokens": 13501,
            "gen_ai.usage.output_tokens": 456,
            "gen_ai.request.model": "gpt-4",
            "gen_ai.response.text": "Perfect. I'll now create the automated workflow with all the steps configured.",
        },
    ))
    s, e = _s(78_030, 72)
    spans.append(create_mock_span(
        span_id=0x0713000000000000, name="execute_tool upsert_workflow",
        start_time=s, end_time=e, parent_span_id=0x0710000000000000,
        attributes={
            "tool.name": "upsert_workflow",
            "tool.parameters": json.dumps({
                "name": "Weekly Expense Report",
                "schedule": {"type": "cron", "expression": "0 17 * * 5"},
                "steps": [
                    {"action": "fetch_google_sheet", "params": {"sheet_id": "expenses_2026"}},
                    {"action": "filter_current_week"},
                    {"action": "generate_summary"},
                    {"action": "send_email", "params": {"to": "cfo@company.com", "format": "html"}},
                ],
                "timezone": "Europe/Amsterdam",
            }),
            "tool.result": json.dumps({"workflow_id": "wf_xyz789", "status": "active"}),
            "tool.status": "success",
        },
    ))
    s, e = _s(78_110, 1_400)
    spans.append(create_mock_span(
        span_id=0x0714000000000000, name="llm",
        start_time=s, end_time=e, parent_span_id=0x0710000000000000,
        attributes={"gen_ai.usage.input_tokens": 330, "gen_ai.usage.output_tokens": 22},
    ))

    # --- Invocation 7: final confirmation ---
    s, e = _s(79_600, 13_000)
    spans.append(create_mock_span(
        span_id=0x0800000000000000, name="invocation [nance_scenario_test]",
        start_time=s, end_time=e, parent_span_id=0x0100000000000000,
    ))
    s, e = _s(79_610, 12_990)
    spans.append(create_mock_span(
        span_id=0x0810000000000000, name="agent_run [workflow_manager_agent]",
        start_time=s, end_time=e, parent_span_id=0x0800000000000000,
    ))
    s, e = _s(79_620, 1_700)
    spans.append(create_mock_span(
        span_id=0x0811000000000000, name="execute_tool upsert_workflow",
        start_time=s, end_time=e, parent_span_id=0x0810000000000000,
        attributes={
            "tool.name": "upsert_workflow",
            "tool.parameters": json.dumps({
                "workflow_id": "wf_xyz789",
                "notification_on_failure": True,
            }),
            "tool.result": json.dumps({"workflow_id": "wf_xyz789", "status": "active", "notification": "enabled"}),
            "tool.status": "success",
        },
    ))
    s, e = _s(81_330, 12_000)
    spans.append(create_mock_span(
        span_id=0x0812000000000000, name="call_llm",
        start_time=s, end_time=e, parent_span_id=0x0810000000000000,
        attributes={
            "gen_ai.usage.input_tokens": 13819,
            "gen_ai.usage.output_tokens": 567,
            "gen_ai.request.model": "gpt-4",
        },
    ))
    # Nance wraps up
    s, e = _s(93_340, 6_700)
    spans.append(create_mock_span(
        span_id=0x0820000000000000, name="agent_run [Nance]",
        start_time=s, end_time=e, parent_span_id=0x0800000000000000,
    ))
    s, e = _s(93_350, 6_690)
    spans.append(create_mock_span(
        span_id=0x0821000000000000, name="call_llm",
        start_time=s, end_time=e, parent_span_id=0x0820000000000000,
        attributes={
            "gen_ai.usage.input_tokens": 19879,
            "gen_ai.usage.output_tokens": 892,
            "gen_ai.request.model": "gpt-4",
            "gen_ai.response.text": (
                "Your automated weekly expense workflow is now live!\n\n"
                "What's been set up:\n"
                "- Schedule: Every Friday at 5:00 PM (Europe/Amsterdam time)\n"
                "- Process: Pulls expenses from your Google Sheet, filters for the current week, "
                "generates a summary, and emails it to cfo@company.com\n"
                "- Fully automated: No manual intervention needed\n"
                "- Notifications: You'll only be notified if the workflow fails"
            ),
        },
    ))

    return spans


def _create_collector(spans: list) -> JudgeSpanCollector:
    collector = MagicMock(spec=JudgeSpanCollector)
    collector.get_spans_for_thread.return_value = spans
    return collector


def _create_input(
    *,
    current_turn: int = 4,
    max_turns: int = 8,
    judgment_request=None,
) -> AgentInput:
    mock_state = MagicMock()
    mock_state.description = "Verify workflow creation agent"
    mock_state.current_turn = current_turn
    mock_state.config.max_turns = max_turns

    return AgentInput(
        thread_id="test-thread",
        messages=[
            {
                "role": "user",
                "content": (
                    "I want to set up a weekly workflow that runs every Friday at 5 PM. "
                    "It should pull this week's expenses, summarize them, and email the "
                    "summary to our CFO. This should run completely automatically."
                ),
            },
            {
                "role": "assistant",
                "content": (
                    "Your automated weekly expense workflow is now live!\n\n"
                    "What's been set up:\n"
                    "- Schedule: Every Friday at 5:00 PM (Europe/Amsterdam time)\n"
                    "- Process: Pulls expenses from your Google Sheet, filters for the current week, "
                    "generates a summary, and emails it to cfo@company.com\n"
                    "- Fully automated: No manual intervention needed\n"
                    "- Notifications: You'll only be notified if the workflow fails\n\n"
                    "The first report will be sent this Friday."
                ),
            },
        ],
        new_messages=[],
        judgment_request=judgment_request,
        scenario_state=mock_state,
    )


def _mock_finish_response(criteria_verdicts: dict, reasoning: str, verdict: str):
    response = MagicMock()
    response.choices = [MagicMock()]
    tc = MagicMock()
    tc.function.name = "finish_test"
    tc.function.arguments = json.dumps({
        "criteria": criteria_verdicts,
        "reasoning": reasoning,
        "verdict": verdict,
    })
    response.choices[0].message.tool_calls = [tc]
    response.choices[0].message.content = None
    return response


def _mock_discovery_response(tool_name: str, args: dict, call_id: str = "call_x"):
    response = MagicMock()
    response.choices = [MagicMock()]
    tc = MagicMock()
    tc.id = call_id
    tc.function.name = tool_name
    tc.function.arguments = json.dumps(args)
    response.choices[0].message.tool_calls = [tc]
    response.choices[0].message.content = None
    response.choices[0].message.role = "assistant"
    return response


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def setup_config():
    ScenarioConfig.default_config = ScenarioConfig(default_model="openai/gpt-4")
    mock_executor = MagicMock()
    mock_executor.config = MagicMock()
    mock_executor.config.cache_key = None
    token = context_scenario.set(mock_executor)
    yield
    context_scenario.reset(token)
    ScenarioConfig.default_config = None


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestNanceTraceTriggersDiscovery:
    """Verify the Nance trace triggers structure-only mode with a low threshold.

    The real-world trace had ~35K tokens of judge context across 10 discovery
    steps. Our fixture is smaller (~2800 tokens) but structurally identical.
    We use token_threshold=100 to force structure-only mode in tests.
    """

    def test_trace_is_substantial(self):
        spans = create_nance_agent_trace()
        assert len(spans) >= 40, f"Expected 40+ spans, got {len(spans)}"

    def test_structure_only_digest_is_compact(self):
        spans = create_nance_agent_trace()
        formatter = JudgeSpanDigestFormatter()
        full_digest = formatter.format(spans)
        structure_digest = formatter.format_structure_only(spans)
        assert len(structure_digest) < len(full_digest) / 2, (
            "Structure-only digest should be much smaller than full digest"
        )


class TestDiscoveryExhaustionForcesVerdict:
    """Core fix: exhausting discovery steps forces a verdict instead of hard-failing."""

    @pytest.mark.asyncio
    async def test_forces_verdict_with_accumulated_context(self):
        """After max_discovery_steps of exploration, the judge should make one
        final LLM call with finish_test forced, not return a hard failure."""
        spans = create_nance_agent_trace()
        collector = _create_collector(spans)
        judge = JudgeAgent(
            criteria=[
                "Agent engages with the workflow scheduling request",
                "Agent creates a task plan for the workflow",
                "Agent sets up deterministic/automatic execution",
            ],
            span_collector=collector,
            max_discovery_steps=3,
            token_threshold=100,
        )

        tool_choices = []
        call_count = 0

        def mock_completion(**kwargs):
            nonlocal call_count
            call_count += 1
            tool_choices.append(kwargs.get("tool_choice"))

            # First 3 calls: judge explores the trace
            if call_count == 1:
                return _mock_discovery_response(
                    "grep_trace", {"pattern": "workflow"}, f"call_{call_count}"
                )
            if call_count == 2:
                return _mock_discovery_response(
                    "expand_trace", {"span_ids": ["06130000"]}, f"call_{call_count}"
                )
            if call_count == 3:
                return _mock_discovery_response(
                    "expand_trace", {"span_ids": ["07130000"]}, f"call_{call_count}"
                )
            # Call 4: forced verdict after exhaustion
            return _mock_finish_response(
                criteria_verdicts={
                    "agent_engages_with_the_workflow_scheduling_request": "true",
                    "agent_creates_a_task_plan_for_the_workflow": "true",
                    "agent_sets_up_deterministic_automatic_execution": "true",
                },
                reasoning=(
                    "After exploring the trace, I found the agent properly engaged "
                    "with the request, created tasks, and set up an automated workflow."
                ),
                verdict="success",
            )

        with patch("scenario.judge_agent.litellm.completion", side_effect=mock_completion):
            result = await judge.call(_create_input())

        # 3 discovery + 1 forced verdict
        assert call_count == 4
        # The forced call must use finish_test
        assert tool_choices[-1] == {"type": "function", "function": {"name": "finish_test"}}
        # Should return the LLM's actual verdict, not a hard failure
        assert isinstance(result, ScenarioResult)
        assert result.success is True
        assert result.reasoning is not None
        assert "workflow" in result.reasoning.lower()

    @pytest.mark.asyncio
    async def test_forced_verdict_can_still_fail(self):
        """The forced verdict can return failure if criteria aren't met."""
        spans = create_nance_agent_trace()
        collector = _create_collector(spans)
        judge = JudgeAgent(
            criteria=[
                "Agent discusses deterministic execution",
                "Agent structures workflow into steps",
            ],
            span_collector=collector,
            max_discovery_steps=2,
            token_threshold=100,
        )

        call_count = 0

        def mock_completion(**kwargs):
            nonlocal call_count
            call_count += 1
            if call_count <= 2:
                return _mock_discovery_response(
                    "expand_trace", {"span_ids": ["01000000"]}, f"call_{call_count}"
                )
            return _mock_finish_response(
                criteria_verdicts={
                    "agent_discusses_deterministic_execution": "false",
                    "agent_structures_workflow_into_steps": "true",
                },
                reasoning="Agent structured steps but never explicitly discussed deterministic execution.",
                verdict="failure",
            )

        with patch("scenario.judge_agent.litellm.completion", side_effect=mock_completion):
            result = await judge.call(_create_input())

        assert isinstance(result, ScenarioResult)
        assert result.success is False
        assert "Agent structures workflow into steps" in result.passed_criteria
        assert "Agent discusses deterministic execution" in result.failed_criteria

    @pytest.mark.asyncio
    async def test_forced_verdict_message_is_appended(self):
        """The forced verdict call includes a user message telling the judge to decide."""
        spans = create_nance_agent_trace()
        collector = _create_collector(spans)
        judge = JudgeAgent(
            criteria=["Agent works"],
            span_collector=collector,
            max_discovery_steps=1,
            token_threshold=100,
        )

        captured_messages = []

        def mock_completion(**kwargs):
            captured_messages.append(kwargs.get("messages", []))
            if len(captured_messages) == 1:
                return _mock_discovery_response(
                    "expand_trace", {"span_ids": ["01000000"]}, "call_1"
                )
            return _mock_finish_response(
                {"agent_works": "true"}, "All good", "success"
            )

        with patch("scenario.judge_agent.litellm.completion", side_effect=mock_completion):
            await judge.call(_create_input())

        # The second call's messages should include the forcing prompt
        forced_messages = captured_messages[-1]
        last_user_msg = [m for m in forced_messages if m.get("role") == "user"][-1]
        assert "maximum" in last_user_msg["content"].lower()
        assert "verdict" in last_user_msg["content"].lower()


class TestDiscoveryToolUsagePatterns:
    """Observe how the judge uses discovery tools to assess whether 10 is sensible."""

    @pytest.mark.asyncio
    async def test_records_full_discovery_trace(self):
        """Records every tool call and tool_choice to inspect the discovery pattern."""
        spans = create_nance_agent_trace()
        collector = _create_collector(spans)
        judge = JudgeAgent(
            criteria=[
                "Agent engages with the workflow scheduling request",
                "Agent creates a task plan for the workflow",
                "Agent sets up deterministic/automatic execution",
            ],
            span_collector=collector,
            max_discovery_steps=6,
            token_threshold=100,
        )

        discovery_log = []
        call_count = 0

        # Simulate a realistic exploration pattern: grep → expand → expand → grep → expand → finish
        def mock_completion(**kwargs):
            nonlocal call_count
            call_count += 1
            tool_choice = kwargs.get("tool_choice")
            discovery_log.append({"step": call_count, "tool_choice": tool_choice})

            if call_count == 1:
                resp = _mock_discovery_response("grep_trace", {"pattern": "workflow"}, f"c{call_count}")
                discovery_log[-1]["tool"] = "grep_trace(workflow)"
                return resp
            if call_count == 2:
                resp = _mock_discovery_response("expand_trace", {"span_ids": ["06130000"]}, f"c{call_count}")
                discovery_log[-1]["tool"] = "expand_trace(transfer_to_agent)"
                return resp
            if call_count == 3:
                resp = _mock_discovery_response("expand_trace", {"span_ids": ["07130000"]}, f"c{call_count}")
                discovery_log[-1]["tool"] = "expand_trace(upsert_workflow)"
                return resp
            if call_count == 4:
                resp = _mock_discovery_response("grep_trace", {"pattern": "create_or_update_task"}, f"c{call_count}")
                discovery_log[-1]["tool"] = "grep_trace(create_or_update_task)"
                return resp
            if call_count == 5:
                resp = _mock_discovery_response("expand_trace", {"span_ids": ["04130000"]}, f"c{call_count}")
                discovery_log[-1]["tool"] = "expand_trace(create_or_update_task)"
                return resp
            # Step 6: judge decides to finish
            discovery_log[-1]["tool"] = "finish_test"
            return _mock_finish_response(
                criteria_verdicts={
                    "agent_engages_with_the_workflow_scheduling_request": "true",
                    "agent_creates_a_task_plan_for_the_workflow": "true",
                    "agent_sets_up_deterministic_automatic_execution": "true",
                },
                reasoning="Trace shows the agent engaged, created tasks, and set up an automated cron workflow.",
                verdict="success",
            )

        with patch("scenario.judge_agent.litellm.completion", side_effect=mock_completion):
            result = await judge.call(_create_input())

        assert isinstance(result, ScenarioResult)

        # Print discovery trace for manual inspection
        print("\n--- Discovery trace ---")
        for entry in discovery_log:
            print(f"  Step {entry['step']}: {entry['tool']}  (tool_choice={entry['tool_choice']})")
        print(f"  Result: success={result.success}")
        print(f"  Steps used: {call_count} / 6 max")
        assert result.success is True
        # Judge finished in 6 steps — didn't need exhaustion
        assert call_count == 6
        # Intermediate steps should use "required", not forced finish_test
        for entry in discovery_log[:-1]:
            assert entry["tool_choice"] == "required"


class TestDiscoveryStepsDefault:
    """Assess whether 10 is a sensible default for max_discovery_steps."""

    def test_nance_trace_span_count(self):
        """Count the spans to calibrate expectations."""
        spans = create_nance_agent_trace()
        # The trace has ~40 spans with nesting. The judge can expand or grep
        # multiple spans per tool call. With ~40 spans, 10 steps gives the
        # judge plenty of budget to:
        # - 1-2 grep calls to find relevant areas
        # - 5-7 expand calls to drill into specific spans
        # - 1-2 buffer steps
        print(f"\nNance trace: {len(spans)} spans")
        assert len(spans) > 30, "Trace should be substantial"

    def test_expand_tool_returns_multiple_spans(self):
        """expand_trace accepts multiple span_ids, so one call can cover many spans."""
        from scenario._judge.trace_tools import expand_trace

        spans = create_nance_agent_trace()
        # Expand 3 spans at once
        result = expand_trace(spans, span_ids=["04130000", "07130000", "08110000"])
        assert "create_or_update_task" in result
        assert "upsert_workflow" in result
        # One call covered 3 key spans — 10 steps is generous

    def test_grep_tool_finds_across_all_spans(self):
        """grep_trace searches all spans at once, so one call can survey the whole trace."""
        from scenario._judge.trace_tools import grep_trace

        spans = create_nance_agent_trace()
        result = grep_trace(spans, "workflow")
        # Should find matches in multiple spans
        assert "upsert_workflow" in result
        assert "workflow_manager_agent" in result.lower() or "workflow" in result.lower()


# ---------------------------------------------------------------------------
# Integration test: run with real LLM to observe actual behavior
# ---------------------------------------------------------------------------

@pytest.mark.skip(reason="Requires OPENAI_API_KEY; run manually with -k real_llm")
@pytest.mark.asyncio
async def test_real_llm_discovery_on_nance_trace():
    """Run the judge with a real LLM against the Nance trace.

    Run manually to observe:
    - Which discovery tools the judge calls
    - In what order
    - How many steps it needs
    - Whether 10 is enough

    Usage:
        pytest tests/test_judge_discovery_exhaustion.py::test_real_llm_discovery_on_nance_trace -s --no-header -k real_llm
    """
    import litellm as _litellm

    spans = create_nance_agent_trace()
    collector = _create_collector(spans)
    judge = JudgeAgent(
        model="openai/gpt-4o",
        criteria=[
            "The upsert_workflow tool is called with a cron schedule for Fridays at 5 PM",
            "The transfer_to_agent tool is used to hand off to workflow_manager_agent",
            "The create_or_update_task tool is called with workflow steps that include email sending",
            "The agent uses ask_user_question at least twice before creating the workflow",
        ],
        span_collector=collector,
        max_discovery_steps=10,
        # Force structure-only mode so the judge must use discovery tools
        token_threshold=100,
    )

    call_log = []
    original_completion = _litellm.completion

    def tracking_completion(**kwargs):
        entry = {
            "call_number": len(call_log) + 1,
            "tool_choice": kwargs.get("tool_choice"),
        }
        call_log.append(entry)
        response = original_completion(**kwargs)  # type: ignore[reportReturnType]
        # Log what tool the judge chose
        msg = response.choices[0].message  # type: ignore[reportAttributeAccessIssue]
        if msg.tool_calls:
            tools_used = [tc.function.name for tc in msg.tool_calls]
            entry["tools_called"] = tools_used
            for tc in msg.tool_calls:
                if tc.function.name in ("expand_trace", "grep_trace"):
                    entry["args"] = json.loads(tc.function.arguments)
        else:
            entry["tools_called"] = ["(no tool call)"]
        return response

    with patch("scenario.judge_agent.litellm.completion", side_effect=tracking_completion):
        # Use mid-conversation turn (not last) so tool_choice is "required"
        # and the judge can freely choose discovery tools
        result = await judge.call(_create_input(
            current_turn=4,
            max_turns=8,
        ))

    assert isinstance(result, ScenarioResult), f"Expected ScenarioResult, got {type(result)}"

    print("\n=== Real LLM Discovery Trace ===")
    for entry in call_log:
        args_str = f"  args={entry.get('args')}" if "args" in entry else ""
        print(
            f"  Call {entry['call_number']}: "
            f"tools={entry['tools_called']}  "
            f"tool_choice={entry['tool_choice']}"
            f"{args_str}"
        )
    print(f"\nTotal LLM calls: {len(call_log)}")
    print(f"Result: success={result.success}")
    print(f"Reasoning: {result.reasoning}")
    print(f"Passed: {result.passed_criteria}")
    print(f"Failed: {result.failed_criteria}")


# ---------------------------------------------------------------------------
# Integration: the renderer fix (#631) reaches the judge's assembled context
# ---------------------------------------------------------------------------
#
# AC1-3/8-13 (in tests/test_judge_utilities.py) prove the RENDERER —
# JudgeUtils.build_transcript_from_messages — emits tool calls. These ACs
# prove the INTEGRATION: that the rendered tool name+args actually land inside
# the <transcript>...</transcript> block of `content_for_judge`, the user
# message JudgeAgent.call() sends to litellm.completion. We mock completion to
# capture that message hermetically (no network, no OPENAI_API_KEY) and assert
# the tool name is in the transcript SLICE specifically — not merely anywhere
# in the string — so the assertion can't be satisfied by the tool name leaking
# from the <opentelemetry_traces> digest.


def _extract_transcript_section(content_for_judge: str) -> str:
    """Return the substring strictly BETWEEN <transcript> and </transcript>.

    The assertion target is this slice, not the whole `content_for_judge`: the
    digest (<opentelemetry_traces>) is a separate channel, and AC4 requires the
    tool name be confirmed in the transcript section specifically — proving it
    is the renderer, not the digest, that surfaces it.
    """
    start_marker = "<transcript>"
    end_marker = "</transcript>"
    start = content_for_judge.index(start_marker) + len(start_marker)
    end = content_for_judge.index(end_marker)
    assert start < end, "Malformed content_for_judge: markers out of order"
    return content_for_judge[start:end]


def _capture_first_content_for_judge() -> tuple[list, "object"]:
    """Build a mock_completion that records `content_for_judge` from the FIRST
    completion call (the user message carrying the transcript), then returns a
    minimal finishing `finish_test` verdict so `JudgeAgent.call()` returns
    immediately without erroring.

    Returns (captured, mock_completion). `captured` is a single-element list
    populated in place: captured[0] is the first user-message content string.
    """
    captured: list = []

    def mock_completion(**kwargs):
        if not captured:
            messages = kwargs.get("messages", [])
            user_msgs = [m for m in messages if m.get("role") == "user"]
            # The first user message is `content_for_judge` (the transcript +
            # digest envelope); a later forcing message may also be user-role,
            # so take the FIRST.
            captured.append(user_msgs[0]["content"] if user_msgs else "")
        # Minimal valid finishing verdict. One criterion -> one verdict key.
        return _mock_finish_response(
            criteria_verdicts={"agent_uses_the_tool": "true"},
            reasoning="Captured transcript; finishing.",
            verdict="success",
        )

    return captured, mock_completion


def _text_input_with_tool_call() -> AgentInput:
    """A text-agent conversation that includes an assistant tool_calls message.

    `get_weather` / `Tokyo` appear ONLY here — they are absent from any OTEL
    digest (this input pairs with an empty span collector), so a hit inside the
    <transcript> slice is attributable to the renderer.
    """
    mock_state = MagicMock()
    mock_state.description = "Verify the agent calls the weather tool"
    mock_state.current_turn = 1
    mock_state.config.max_turns = 8
    return AgentInput(
        thread_id="test-thread",
        messages=cast(Any, [
            {"role": "user", "content": "What's the weather in Tokyo?"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "c1",
                        "type": "function",
                        "function": {
                            "name": "get_weather",
                            "arguments": '{"city":"Tokyo"}',
                        },
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "c1", "content": "18C and sunny"},
            {"role": "assistant", "content": "It's 18C and sunny in Tokyo."},
        ]),
        new_messages=[],
        judgment_request=None,
        scenario_state=mock_state,
    )


def _voice_input_with_tool_call() -> AgentInput:
    """A synthetic AUDIO conversation that ALSO carries a tool_calls message.

    An assistant turn includes an `input_audio` content part (so the message
    list is voice-shaped); a SEPARATE assistant turn carries the tool_calls.
    The renderer is the single transcript call site, so the tool name must
    surface for voice exactly as it does for text. `get_weather` / `Tokyo`
    appear only in the tool_call, not the audio bytes.
    """
    mock_state = MagicMock()
    mock_state.description = "Verify the voice agent calls the weather tool"
    mock_state.current_turn = 1
    mock_state.config.max_turns = 8
    # ~1KB of base64-ish bytes so the audio part is a realistic voice payload
    # (it gets truncated to [AUDIO: ...] by the renderer regardless).
    fake_audio_b64 = "A" * 1024
    return AgentInput(
        thread_id="test-thread",
        messages=cast(Any, [
            {"role": "user", "content": "What's the weather in Tokyo?"},
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "input_audio",
                        "input_audio": {"data": fake_audio_b64, "format": "wav"},
                    }
                ],
            },
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "c1",
                        "type": "function",
                        "function": {
                            "name": "get_weather",
                            "arguments": '{"city":"Tokyo"}',
                        },
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "c1", "content": "18C and sunny"},
        ]),
        new_messages=[],
        judgment_request=None,
        scenario_state=mock_state,
    )


def _realtime_adapter_output_with_tool_call() -> AgentInput:
    """The EXACT message list ``OpenAIRealtimeAgentAdapter.call()`` returns when
    the agent calls a tool during a spoken turn (openai_realtime.py:595-600):
    ``[audio_message, tool_call_message]``.

    - ``audio_message``: an assistant turn carrying an ``input_audio`` part (the
      spoken reply). Mirrors what ``create_audio_message`` emits.
    - ``tool_call_message``: a SEPARATE assistant turn with ``content=None`` and
      a ``tool_calls`` list — byte-for-byte the dict the realtime adapter
      appends.

    ``book_flight`` / ``Paris`` appear ONLY in the tool_call (this input pairs
    with an empty span collector), so a hit inside the <transcript> slice is
    attributable to the renderer, not the OTEL digest.
    """
    mock_state = MagicMock()
    mock_state.description = "Verify the realtime agent calls the booking tool"
    mock_state.current_turn = 1
    mock_state.config.max_turns = 8
    # ~1KB of base64-ish bytes so the audio part is a realistic spoken payload
    # (truncated to [AUDIO: ...] by the renderer regardless).
    fake_audio_b64 = "A" * 1024
    audio_message = {
        "role": "assistant",
        "content": [
            {
                "type": "input_audio",
                "input_audio": {"data": fake_audio_b64, "format": "wav"},
            }
        ],
    }
    # Literal shape returned by OpenAIRealtimeAgentAdapter.call() (the second
    # list element): one assistant message, content=None, one tool call.
    tool_call_message = {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": "c1",
                "type": "function",
                "function": {
                    "name": "book_flight",
                    "arguments": '{"location":"Paris"}',
                },
            }
        ],
    }
    return AgentInput(
        thread_id="test-thread",
        messages=cast(Any, [
            {"role": "user", "content": "Book me a flight to Paris."},
            audio_message,
            tool_call_message,
        ]),
        new_messages=[],
        judgment_request=None,
        scenario_state=mock_state,
    )


class TestToolCallReachesJudgeContext:
    """#631 integration: a rendered tool call reaches `content_for_judge`'s
    <transcript> block — across the text path, the voice path, and the
    large-trace path where the OTEL digest is truncated to structure-only.

    #630 AC5 additionally proves the realtime adapter's exact
    ``[audio_message, tool_call_message]`` output surfaces the tool call in the
    transcript with an empty span collector (digest cannot be the source)."""

    @pytest.mark.asyncio
    async def test_ac4_text_path_tool_name_in_transcript_section(self):
        """AC4: text-agent conversation with an assistant tool_calls message ->
        the tool name+args land INSIDE <transcript>, not merely anywhere in the
        judge context (so it can't be leaking from the digest)."""
        # Empty span collector -> digest is "No spans recorded.", so
        # `get_weather` cannot come from the OTEL channel.
        judge = JudgeAgent(
            criteria=["Agent uses the tool"],
            span_collector=_create_collector([]),
        )

        captured, mock_completion = _capture_first_content_for_judge()
        with patch(
            "scenario.judge_agent.litellm.completion", side_effect=mock_completion
        ):
            await judge.call(_text_input_with_tool_call())

        assert captured, "completion was never called; content_for_judge not captured"
        content_for_judge = captured[0]
        transcript = _extract_transcript_section(content_for_judge)

        # Attributable to the transcript: absent from the digest channel.
        assert "get_weather" not in content_for_judge.split("<transcript>")[0]
        assert "get_weather" in transcript
        assert "Tokyo" in transcript
        # The renderer's tool-call shape, and the tool-result attribution.
        assert "[tool_call: get_weather(" in transcript
        assert "tool (get_weather):" in transcript

    @pytest.mark.asyncio
    async def test_ac5_voice_path_tool_name_in_transcript_section(self):
        """AC5: a synthetic AUDIO message list that ALSO carries a tool_calls
        message -> the tool name renders in <transcript>. Proves the
        path-agnostic builder covers voice (the renderer is the single call
        site). include_audio=True keeps it hermetic: the audio-transcription
        fallback (which would hit the network) is skipped."""
        judge = JudgeAgent(
            criteria=["Agent uses the tool"],
            span_collector=_create_collector([]),
            # Skip the transcribe-audio fallback branch -> no network. Does NOT
            # rely on _enrich_messages_with_transcripts to render tool calls.
            include_audio=True,
        )

        captured, mock_completion = _capture_first_content_for_judge()
        with patch(
            "scenario.judge_agent.litellm.completion", side_effect=mock_completion
        ):
            await judge.call(_voice_input_with_tool_call())

        assert captured, "completion was never called; content_for_judge not captured"
        content_for_judge = captured[0]
        transcript = _extract_transcript_section(content_for_judge)

        assert "get_weather" not in content_for_judge.split("<transcript>")[0]
        assert "get_weather" in transcript
        assert "Tokyo" in transcript
        # The audio part is present (rendered as a truncated AUDIO marker) AND
        # the tool call surfaces alongside it.
        assert "[AUDIO:" in transcript
        assert "[tool_call: get_weather(" in transcript

    @pytest.mark.asyncio
    async def test_ac6_large_trace_structure_only_digest_still_carries_tool_call(self):
        """AC6 (load-bearing): with a large trace, `_build_trace_digest` returns
        the STRUCTURE-ONLY digest (span skeleton, NO attributes/args). The
        transcript is an independent channel, so the tool name+args must STILL
        appear in <transcript> even though the digest dropped them. Tool name
        `check_inventory` and arg `SKU-42` are absent from the structure-only
        digest, so a hit is attributable solely to the transcript."""
        spans = create_nance_agent_trace()  # ~45 spans, digest ~2800 tokens
        judge = JudgeAgent(
            criteria=["Agent uses the tool"],
            span_collector=_create_collector(spans),
            # Tiny threshold -> is_large_trace=True -> structure-only digest.
            token_threshold=50,
            max_discovery_steps=4,
        )

        mock_state = MagicMock()
        mock_state.description = "Verify the agent checks inventory"
        mock_state.current_turn = 1
        mock_state.config.max_turns = 8
        large_trace_input = AgentInput(
            thread_id="test-thread",
            messages=cast(Any, [
                {"role": "user", "content": "Check stock for SKU-42."},
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "c1",
                            "type": "function",
                            "function": {
                                "name": "check_inventory",
                                "arguments": '{"sku":"SKU-42"}',
                            },
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": "c1", "content": "12 units in stock"},
            ]),
            new_messages=[],
            judgment_request=None,
            scenario_state=mock_state,
        )

        captured, mock_completion = _capture_first_content_for_judge()
        with patch(
            "scenario.judge_agent.litellm.completion", side_effect=mock_completion
        ):
            await judge.call(large_trace_input)

        assert captured, "completion was never called; content_for_judge not captured"
        content_for_judge = captured[0]
        transcript = _extract_transcript_section(content_for_judge)
        digest_section = content_for_judge.split("</transcript>", 1)[1]

        # Precondition: structure-only mode actually engaged — the digest tells
        # the judge to use expand/grep (only emitted for large traces) and does
        # NOT carry the tool name/args itself.
        assert "expand_trace" in digest_section, (
            "Expected structure-only digest (large trace) but digest looks full"
        )
        assert "check_inventory" not in digest_section
        assert "SKU-42" not in digest_section

        # Load-bearing: the transcript is the ONLY channel carrying the tool
        # name+args; it survived digest truncation.
        assert "check_inventory" in transcript
        assert "SKU-42" in transcript
        assert "[tool_call: check_inventory(" in transcript

        # Make the transcript slice visible so a reviewer can SEE the tool call
        # is in it (AC6 must not be vacuous).
        print("\n--- AC6 captured <transcript> slice ---")
        print(transcript)
        print("--- end <transcript> slice ---")

    @pytest.mark.asyncio
    async def test_ac5_realtime_tool_call_shape_reaches_judge_transcript(self):
        """AC5 of #630 — realtime tool calls reach the judge via the transcript
        channel (post-#631 renderer), asserted with an empty span collector so
        the digest cannot be the source.

        This drives the EXACT message list that ``OpenAIRealtimeAgentAdapter.call()``
        now returns when the agent calls a tool during a spoken turn:
        ``[audio_message, tool_call_message]`` where the audio message is an
        assistant turn carrying an ``input_audio`` part and the tool-call message
        is a SEPARATE assistant turn ``{"role":"assistant","content":None,
        "tool_calls":[...]}`` (openai_realtime.py:595-600). With an empty span
        collector the OTEL digest is "No spans recorded.", so a hit on the tool
        name inside <transcript> is attributable solely to the renderer — proving
        realtime tool calls reach the judge through the TRANSCRIPT channel, the
        post-#631 reality (no OTEL span needs to be emitted)."""
        # Empty span collector -> digest is "No spans recorded.", so the tool
        # name `book_flight` cannot come from the OTEL channel.
        judge = JudgeAgent(
            criteria=["Agent uses the tool"],
            span_collector=_create_collector([]),
            # Skip the transcribe-audio fallback (would hit the network); the
            # tool call is rendered by build_transcript_from_messages regardless.
            include_audio=True,
        )

        captured, mock_completion = _capture_first_content_for_judge()
        with patch(
            "scenario.judge_agent.litellm.completion", side_effect=mock_completion
        ):
            await judge.call(_realtime_adapter_output_with_tool_call())

        assert captured, "completion was never called; content_for_judge not captured"
        content_for_judge = captured[0]
        transcript = _extract_transcript_section(content_for_judge)

        # Attributable to the transcript channel: the tool name is absent from
        # everything BEFORE <transcript> (system prompt + the "No spans recorded."
        # digest), so it cannot be leaking from the digest / system prompt.
        pre_transcript = content_for_judge.split("<transcript>")[0]
        assert "book_flight" not in pre_transcript
        assert "Paris" not in pre_transcript
        # Precondition: the empty span collector really did yield an empty digest,
        # so the transcript is provably the only channel that could carry it.
        assert "No spans recorded." in content_for_judge

        # Load-bearing: the realtime-shaped tool call surfaces in <transcript>.
        assert "book_flight" in transcript
        assert "Paris" in transcript
        # The renderer's tool-call shape, alongside the spoken (audio) turn.
        assert "[tool_call: book_flight(" in transcript
        assert "[AUDIO:" in transcript

        # Make the transcript slice visible so a reviewer can SEE the realtime
        # tool call is inside it (AC5 must not be vacuous).
        print("\n--- AC5 (#630) captured <transcript> slice ---")
        print(transcript)
        print("--- end <transcript> slice ---")
