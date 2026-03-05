"""Integration test: judge uses discovery tools before verdict with large traces.

Uses real Sonnet 4 via Anthropic to verify the judge actually calls
expand_trace/grep_trace when given a structure-only trace view.
"""

import json
from unittest.mock import MagicMock, patch

import pytest
from dotenv import load_dotenv

from scenario import JudgeAgent
from scenario._tracing.judge_span_collector import JudgeSpanCollector
from scenario.cache import context_scenario
from scenario.config import ScenarioConfig
from scenario.types import AgentInput, JudgmentRequest

from tests.helpers.create_span import create_mock_span

load_dotenv()


def create_analytics_agent_trace() -> list:
    """Creates a trace mimicking an analytics agent that processes a data
    visualization request. Large enough to trigger structure-only mode.

    Based on a real trace where the agent:
    1. Classifies the user's intent
    2. Resolves date ranges
    3. Fetches relevant columns
    4. Creates a pie chart visualization
    5. Returns a summary
    """
    base_time = 1700000000_000_000_000
    spans = []

    # Root span
    spans.append(create_mock_span(
        span_id=0x0CDD4B3200000000,
        name="AnalyticsAgent.call",
        start_time=base_time,
        end_time=base_time + 39_750_000_000,
        attributes={
            "agent.name": "analytics-agent",
            "agent.version": "2.1.0",
        },
    ))

    # Inner agent span
    spans.append(create_mock_span(
        span_id=0x55E3020800000000,
        name="analytics_scenario",
        start_time=base_time + 1_000_000,
        end_time=base_time + 39_740_000_000,
        parent_span_id=0x0CDD4B3200000000,
        attributes={
            "scenario.type": "analytics",
            "user.query": "Show me cost allocation by channel as a pie chart for last month",
        },
    ))

    # Entity classifier
    spans.append(create_mock_span(
        span_id=0x9AF1D3F600000000,
        name="entities_classifier",
        start_time=base_time + 462_000_000,
        end_time=base_time + 2_722_000_000,
        parent_span_id=0x55E3020800000000,
        attributes={
            "classifier.result": json.dumps({
                "intent": "data_visualization",
                "entities": ["cost", "channel", "pie_chart", "last_month"],
                "confidence": 0.95,
            }),
        },
    ))

    # Classifier prompt fetch
    spans.append(create_mock_span(
        span_id=0xF962294000000000,
        name="PromptService.get",
        start_time=base_time + 467_000_000,
        end_time=base_time + 853_000_000,
        parent_span_id=0x9AF1D3F600000000,
        attributes={
            "prompt.name": "entity_classifier_v3",
            "prompt.version": "3.2.1",
        },
    ))

    # Classifier prompt compile
    spans.append(create_mock_span(
        span_id=0xC8CB3B8100000000,
        name="Prompt.compile",
        start_time=base_time + 854_000_000,
        end_time=base_time + 854_500_000,
        parent_span_id=0x9AF1D3F600000000,
    ))

    # Performance agent
    spans.append(create_mock_span(
        span_id=0xB195B7DF00000000,
        name="performance_agent",
        start_time=base_time + 2_992_000_000,
        end_time=base_time + 40_022_000_000,
        parent_span_id=0x55E3020800000000,
        attributes={
            "agent.type": "performance",
            "agent.framework": "strands",
        },
    ))

    # LLM agent invoke
    spans.append(create_mock_span(
        span_id=0x3AAEF12400000000,
        name="invoke_agent Strands Agents",
        start_time=base_time + 2_998_000_000,
        end_time=base_time + 39_718_000_000,
        parent_span_id=0xB195B7DF00000000,
        attributes={
            "gen_ai.usage.input_tokens": 25000,
            "gen_ai.usage.output_tokens": 12293,
            "gen_ai.system": "anthropic",
            "gen_ai.request.model": "claude-sonnet-4-20250514",
        },
    ))

    # First event loop cycle
    spans.append(create_mock_span(
        span_id=0xE0896EF900000000,
        name="execute_event_loop_cycle",
        start_time=base_time + 2_998_500_000,
        end_time=base_time + 22_488_000_000,
        parent_span_id=0x3AAEF12400000000,
    ))

    # First LLM chat
    spans.append(create_mock_span(
        span_id=0xAA33252900000000,
        name="chat",
        start_time=base_time + 2_998_600_000,
        end_time=base_time + 6_298_000_000,
        parent_span_id=0xE0896EF900000000,
        attributes={
            "gen_ai.usage.input_tokens": 11778,
            "gen_ai.usage.output_tokens": 500,
            "gen_ai.response.text": "I'll help you visualize your cost allocation by channel for the past month. Let me start by resolving the date range and getting the relevant columns.",
        },
    ))

    # resolve_date_range tool call
    spans.append(create_mock_span(
        span_id=0xB2C3A20600000000,
        name="execute_tool resolve_date_range",
        start_time=base_time + 6_791_000_000,
        end_time=base_time + 6_803_000_000,
        parent_span_id=0xE0896EF900000000,
        attributes={
            "tool.name": "resolve_date_range",
            "tool.status": "success",
        },
    ))
    spans.append(create_mock_span(
        span_id=0x26A9709E00000000,
        name="resolve_date_range",
        start_time=base_time + 6_792_000_000,
        end_time=base_time + 6_803_000_000,
        parent_span_id=0xB2C3A20600000000,
        attributes={
            "tool.parameters": json.dumps({"preset": "LASTMONTH"}),
            "tool.result": json.dumps({
                "preset": "LASTMONTH",
                "start_date": "2026-02-01",
                "end_date": "2026-02-28",
                "type": "MONTHS",
                "range": 1,
            }),
        },
    ))

    # relevant_columns tool call
    spans.append(create_mock_span(
        span_id=0x51D1361700000000,
        name="execute_tool relevant_columns",
        start_time=base_time + 6_803_000_000,
        end_time=base_time + 20_883_000_000,
        parent_span_id=0xE0896EF900000000,
        attributes={
            "tool.name": "relevant_columns",
            "tool.status": "success",
        },
    ))
    spans.append(create_mock_span(
        span_id=0xAA3BA22F00000000,
        name="relevant_columns",
        start_time=base_time + 6_805_000_000,
        end_time=base_time + 20_875_000_000,
        parent_span_id=0x51D1361700000000,
        attributes={
            "tool.result": json.dumps([
                {"name": "Cost", "group": "PERFORMANCE"},
                {"name": "ChannelName", "group": "ATTRIBUTES", "display_name": "Channel"},
                {"name": "AccountName", "group": "ATTRIBUTES", "display_name": "Account Name"},
                {"name": "CampaignId", "group": "ATTRIBUTES", "display_name": "Campaign ID"},
                {"name": "CampaignName", "group": "ATTRIBUTES", "display_name": "Campaign Name"},
                {"name": "ProfileId", "group": "ATTRIBUTES", "display_name": "Profile ID"},
                {"name": "ProfileName", "group": "ATTRIBUTES", "display_name": "Profile Name"},
                {"name": "ChannelCategory", "group": "ATTRIBUTES", "display_name": "Category"},
            ]),
        },
    ))

    # Second event loop cycle
    spans.append(create_mock_span(
        span_id=0xC750C5D700000000,
        name="execute_event_loop_cycle",
        start_time=base_time + 22_780_000_000,
        end_time=base_time + 33_920_000_000,
        parent_span_id=0x3AAEF12400000000,
    ))

    # Second LLM chat
    spans.append(create_mock_span(
        span_id=0x09E349AE00000000,
        name="chat",
        start_time=base_time + 22_781_000_000,
        end_time=base_time + 28_641_000_000,
        parent_span_id=0xC750C5D700000000,
        attributes={
            "gen_ai.usage.input_tokens": 12577,
            "gen_ai.usage.output_tokens": 800,
            "gen_ai.response.text": "Now I'll create a pie chart visualization to show your cost allocation by channel for February 2026:",
        },
    ))

    # data_visualization tool call
    spans.append(create_mock_span(
        span_id=0x784F7C8F00000000,
        name="execute_tool data_visualization",
        start_time=base_time + 29_536_000_000,
        end_time=base_time + 33_506_000_000,
        parent_span_id=0xC750C5D700000000,
        attributes={
            "tool.name": "data_visualization",
            "tool.status": "success",
        },
    ))
    spans.append(create_mock_span(
        span_id=0xFD8EC6EF00000000,
        name="data_visualization",
        start_time=base_time + 29_537_000_000,
        end_time=base_time + 33_507_000_000,
        parent_span_id=0x784F7C8F00000000,
        attributes={
            "tool.parameters": json.dumps({
                "chart_type": "pie",
                "metrics": [{"name": "Cost", "group": "PERFORMANCE"}],
                "group_bys": [{"name": "ChannelName", "display_name": "Channel"}],
                "sort_by": {"name": "Cost", "order": "descending"},
                "date_range": {"start": "2026-02-01", "end": "2026-02-28"},
            }),
            "tool.result": json.dumps({
                "status": "success",
                "file_id": 999999,
                "metrics": [{"name": "Cost", "display_name": "Cost", "value_type": "MONETARY", "group": "PERFORMANCE"}],
                "group_by": {"name": "ChannelName", "display_name": "Channel"},
                "totals": {"currency": "$", "Cost": "3561228.92"},
            }),
        },
    ))

    # Fetch report sub-span
    spans.append(create_mock_span(
        span_id=0xA46BDFE300000000,
        name="fetch_report",
        start_time=base_time + 30_233_000_000,
        end_time=base_time + 33_503_000_000,
        parent_span_id=0xFD8EC6EF00000000,
        attributes={
            "report.query_time_ms": 2800,
            "report.rows_returned": 5,
            "report.csv_data": "Channel,Cost\nGoogle Ads,1500000.00\nMeta Ads,1200000.00\nAmazon Ads,500000.00\nTikTok Ads,250000.00\nLinkedIn Ads,111228.92",
        },
    ))

    # Third event loop cycle
    spans.append(create_mock_span(
        span_id=0x71CC31DC00000000,
        name="execute_event_loop_cycle",
        start_time=base_time + 34_236_000_000,
        end_time=base_time + 39_016_000_000,
        parent_span_id=0x3AAEF12400000000,
    ))

    # Final LLM chat
    spans.append(create_mock_span(
        span_id=0x9798082000000000,
        name="chat",
        start_time=base_time + 34_236_500_000,
        end_time=base_time + 38_346_000_000,
        parent_span_id=0x71CC31DC00000000,
        attributes={
            "gen_ai.usage.input_tokens": 12938,
            "gen_ai.usage.output_tokens": 993,
            "gen_ai.response.text": (
                "I've created a pie chart visualization showing your cost allocation by channel for February 2026. "
                "The chart displays:\n\n"
                "**Cost Allocation by Channel - February 2026**\n\n"
                "- **Total Spend**: $3,561,228.92\n"
                "- **Visualization Type**: Pie chart showing proportional distribution\n"
                "- **Time Period**: February 1-28, 2026\n\n"
                "The pie chart will show you exactly how your advertising budget was distributed across different "
                "channels during the past month. Each slice represents a channel's share of your total advertising spend."
            ),
        },
    ))

    return spans


@pytest.fixture(autouse=True)
def setup_config():
    """Set up default config for all tests."""
    ScenarioConfig.default_config = ScenarioConfig(
        default_model="anthropic/claude-sonnet-4-20250514"
    )
    mock_executor = MagicMock()
    mock_executor.config = MagicMock()
    mock_executor.config.cache_key = None
    token = context_scenario.set(mock_executor)
    yield
    context_scenario.reset(token)
    ScenarioConfig.default_config = None


@pytest.mark.skip(reason="Requires ANTHROPIC_API_KEY with credits; run manually")
@pytest.mark.agent_test
@pytest.mark.asyncio
async def test_sonnet_uses_discovery_tools_before_verdict():
    """Integration test: Sonnet 4 should use expand_trace/grep_trace
    to investigate the trace before delivering a verdict when given a
    structure-only trace view with enforced judgment.

    This test verifies the fix for a bug where tool_choice was forced
    to finish_test on every loop iteration, preventing discovery tools.
    """
    spans = create_analytics_agent_trace()
    collector = MagicMock(spec=JudgeSpanCollector)
    collector.get_spans_for_thread.return_value = spans

    judge = JudgeAgent(
        model="anthropic/claude-sonnet-4-20250514",
        criteria=[
            "resolve_date_range tool is called with LASTMONTH preset",
            "data_visualization tool is called with chart_type='pie'",
            "data_visualization uses ChannelName in group_bys",
            "data_visualization sorts by Cost descending",
            "Visualization successfully creates and returns a file_id",
            "Final response mentions the time period",
            "All tool calls complete with status='success'",
        ],
        span_collector=collector,
        # Low threshold to ensure structure-only mode
        token_threshold=100,
        max_discovery_steps=5,
    )

    mock_scenario_state = MagicMock()
    mock_scenario_state.description = "Verify analytics agent creates a pie chart of cost by channel"
    mock_scenario_state.current_turn = 1
    mock_scenario_state.config.max_turns = 1  # Last turn = enforced verdict

    input_ = AgentInput(
        thread_id="test-thread",
        messages=[
            {"role": "user", "content": "Show me cost allocation by channel as a pie chart for last month"},
            {"role": "assistant", "content": (
                "I've created a pie chart visualization showing your cost allocation by channel for February 2026. "
                "The chart displays:\n\n"
                "**Cost Allocation by Channel - February 2026**\n\n"
                "- **Total Spend**: $3,561,228.92\n"
                "- **Visualization Type**: Pie chart showing proportional distribution\n"
                "- **Time Period**: February 1-28, 2026"
            )},
        ],
        new_messages=[],
        judgment_request=JudgmentRequest(criteria=None),
        scenario_state=mock_scenario_state,
    )

    # Track LLM calls to verify discovery happens
    original_completion = __import__("litellm").completion
    call_log = []

    def tracking_completion(**kwargs):
        tool_choice = kwargs.get("tool_choice")
        call_log.append({
            "tool_choice": tool_choice,
            "call_number": len(call_log) + 1,
        })
        return original_completion(**kwargs)

    with patch("scenario.judge_agent.litellm.completion", side_effect=tracking_completion):
        result = await judge.call(input_)

    print(f"\n--- Integration test results ---")
    print(f"Total LLM calls: {len(call_log)}")
    for i, call in enumerate(call_log):
        print(f"  Call {i+1}: tool_choice={call['tool_choice']}")
    print(f"Result: success={result.success if hasattr(result, 'success') else 'N/A'}")
    if hasattr(result, "reasoning"):
        print(f"Reasoning: {result.reasoning[:200]}...")

    # The judge should have made at least 2 calls:
    # 1+ discovery calls (expand_trace/grep_trace) + 1 finish_test
    assert len(call_log) >= 2, (
        f"Expected at least 2 LLM calls (discovery + verdict), got {len(call_log)}. "
        f"The judge likely skipped discovery and went straight to finish_test."
    )

    # First call should NOT force finish_test
    first_tool_choice = call_log[0]["tool_choice"]
    assert first_tool_choice != {"type": "function", "function": {"name": "finish_test"}}, (
        f"First call should use 'required' tool_choice for discovery, got: {first_tool_choice}"
    )
