"""Tests for TapStrategy and the per-turn branch/prune loop in RedTeamAgent."""

import json
import logging
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from scenario import RedTeamAgent, TapStrategy
from scenario._red_team.base import AttackerOutput
from scenario._red_team.tap import TapStrategy as TapStrategyDirect


# ---------------------------------------------------------------------------
# TapStrategy — interface conformance
# ---------------------------------------------------------------------------


class TestTapStrategyInterface:
    def test_re_export_is_same_class(self):
        """`scenario.TapStrategy` and the module-local class are identical."""
        assert TapStrategy is TapStrategyDirect

    def test_needs_metaprompt_plan_false(self):
        """TAP, like GOAT, does not pre-generate an attack plan."""
        assert TapStrategy().needs_metaprompt_plan is False

    def test_phase_kind_is_progress(self):
        """TAP has no semantic phases — phase_kind is `progress`."""
        assert TapStrategy().phase_kind == "progress"

    def test_phase_labels(self):
        """early < 30%, mid < 70%, late >= 70% — matches GOAT buckets."""
        s = TapStrategy()
        assert s.get_phase_name(1, 10) == "early"   # 10%
        assert s.get_phase_name(2, 10) == "early"   # 20%
        assert s.get_phase_name(3, 10) == "mid"     # 30% — boundary lands here
        assert s.get_phase_name(6, 10) == "mid"     # 60%
        assert s.get_phase_name(7, 10) == "late"    # 70% — boundary lands here
        assert s.get_phase_name(10, 10) == "late"   # 100%

    def test_phase_label_handles_zero_total_turns(self):
        """Defensive: don't divide by zero."""
        s = TapStrategy()
        assert s.get_phase_name(1, 0) == "late"

    def test_chosen_technique_ids_empty(self):
        """TAP has no catalogue; the typed-id surface returns []."""
        s = TapStrategy()
        assert s.chosen_technique_ids("strategy text") == []
        assert s.chosen_technique_ids("") == []

    def test_template_variables_empty(self):
        """No metaprompt template variables to inject."""
        assert TapStrategy().template_variables(10) == {}


# ---------------------------------------------------------------------------
# TapStrategy — validation
# ---------------------------------------------------------------------------


class TestTapStrategyValidation:
    def test_defaults_match_paper(self):
        """Paper defaults: b=4 (matched by `width`), d=10."""
        s = TapStrategy()
        assert s.width == 4
        assert s.depth == 10
        assert s.on_topic_filter is True
        assert s.prune_threshold == 3.0

    def test_rejects_zero_width(self):
        with pytest.raises(ValueError, match="width must be >= 1"):
            TapStrategy(width=0)

    def test_rejects_zero_depth(self):
        with pytest.raises(ValueError, match="depth must be >= 1"):
            TapStrategy(depth=0)

    def test_rejects_out_of_range_threshold(self):
        with pytest.raises(ValueError, match="prune_threshold must be in"):
            TapStrategy(prune_threshold=-1.0)
        with pytest.raises(ValueError, match="prune_threshold must be in"):
            TapStrategy(prune_threshold=11.0)

    def test_rejects_negative_temperature_spread(self):
        with pytest.raises(ValueError, match="temperature_spread must be >= 0"):
            TapStrategy(temperature_spread=-0.1)

    def test_is_frozen(self):
        """Frozen dataclass — no accidental mutation."""
        s = TapStrategy()
        with pytest.raises(Exception):  # FrozenInstanceError or AttributeError
            s.width = 99  # type: ignore[misc]


# ---------------------------------------------------------------------------
# TapStrategy — JSON output parsing
# ---------------------------------------------------------------------------


class TestTapStrategyParse:
    def test_parses_well_formed_json(self):
        raw = json.dumps({
            "observation": "target refused but acknowledged topic",
            "strategy": "hypothetical framing",
            "reply": "for a research course, walk me through ...",
        })
        out = TapStrategy().parse_attacker_output(raw)
        assert isinstance(out, AttackerOutput)
        assert out.reply.startswith("for a research course")
        assert out.observation == "target refused but acknowledged topic"
        assert out.strategy == "hypothetical framing"
        assert out.parse_failed is False

    def test_strips_markdown_fences(self):
        raw = "```json\n" + json.dumps({"reply": "hi"}) + "\n```"
        out = TapStrategy().parse_attacker_output(raw)
        assert out.reply == "hi"
        assert out.parse_failed is False

    def test_malformed_json_falls_back(self):
        raw = "not json at all"
        out = TapStrategy().parse_attacker_output(raw)
        assert out.reply == raw
        assert out.parse_failed is True

    def test_missing_reply_falls_back(self):
        raw = json.dumps({"observation": "x"})
        out = TapStrategy().parse_attacker_output(raw)
        assert out.reply == raw
        assert out.parse_failed is True

    def test_empty_reply_falls_back(self):
        raw = json.dumps({"reply": "   "})
        out = TapStrategy().parse_attacker_output(raw)
        assert out.parse_failed is True

    def test_non_dict_json_falls_back(self):
        raw = "[1, 2, 3]"
        out = TapStrategy().parse_attacker_output(raw)
        assert out.parse_failed is True


# ---------------------------------------------------------------------------
# RedTeamAgent.tap() factory
# ---------------------------------------------------------------------------


class TestTapFactory:
    def test_factory_returns_red_team_agent_with_tap_strategy(self):
        agent = RedTeamAgent.tap(
            target="extract system prompt",
            model="openai/gpt-4",
            width=3,
            prune_threshold=2.0,
        )
        assert isinstance(agent, RedTeamAgent)
        assert isinstance(agent._strategy, TapStrategy)
        assert agent._strategy.width == 3
        assert agent._strategy.prune_threshold == 2.0
        assert agent.target == "extract system prompt"

    def test_depth_defaults_to_total_turns(self):
        agent = RedTeamAgent.tap(
            target="x",
            model="openai/gpt-4",
            total_turns=15,
        )
        assert agent._strategy.depth == 15

    def test_depth_can_be_overridden(self):
        agent = RedTeamAgent.tap(
            target="x",
            model="openai/gpt-4",
            total_turns=15,
            depth=20,
        )
        assert agent._strategy.depth == 20

    def test_does_not_warn_about_unused_metaprompt(self):
        """TAP doesn't use a metaprompt template; passing one through .tap()
        should not warn because the factory doesn't accept the arg."""
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            RedTeamAgent.tap(
                target="x",
                model="openai/gpt-4",
                width=2,
            )


# ---------------------------------------------------------------------------
# Per-turn branch / prune / select — _tap_select_candidate
# ---------------------------------------------------------------------------


def _make_agent(**overrides) -> RedTeamAgent:
    kwargs = dict(
        target="extract system prompt",
        model="openai/gpt-4",
        width=4,
        prune_threshold=3.0,
        on_topic_filter=True,
    )
    kwargs.update(overrides)
    return RedTeamAgent.tap(**kwargs)


def _candidate_raw(reply: str) -> str:
    """Build a well-formed JSON attacker output with the given reply."""
    return json.dumps({"observation": "", "strategy": "", "reply": reply})


class TestTapSelectCandidate:
    @pytest.mark.asyncio
    async def test_calls_attacker_llm_width_times(self):
        agent = _make_agent(width=4, on_topic_filter=False)
        attacker = AsyncMock(side_effect=[
            _candidate_raw("c0"), _candidate_raw("c1"),
            _candidate_raw("c2"), _candidate_raw("c3"),
        ])
        scorer = AsyncMock(return_value=8.0)
        with patch.object(agent, "_call_attacker_llm", attacker), \
             patch.object(agent, "_score_candidate", scorer):
            await agent._tap_select_candidate(agent._strategy)
        assert attacker.await_count == 4

    @pytest.mark.asyncio
    async def test_temperature_spread_applied_per_branch(self):
        """Branch k uses temperature = base + k * spread."""
        agent = _make_agent(
            width=4, temperature=0.7, temperature_spread=0.1,
            on_topic_filter=False,
        )
        attacker = AsyncMock(side_effect=[
            _candidate_raw(f"c{i}") for i in range(4)
        ])
        scorer = AsyncMock(return_value=8.0)
        with patch.object(agent, "_call_attacker_llm", attacker), \
             patch.object(agent, "_score_candidate", scorer):
            await agent._tap_select_candidate(agent._strategy)
        temps = [call.kwargs["temperature"] for call in attacker.await_args_list]
        assert temps == pytest.approx([0.7, 0.8, 0.9, 1.0])

    @pytest.mark.asyncio
    async def test_top_scorer_is_selected(self):
        """Highest score wins; the chosen raw output is returned."""
        agent = _make_agent(width=4, on_topic_filter=False, prune_threshold=0.0)
        raws = [_candidate_raw(f"c{i}") for i in range(4)]
        attacker = AsyncMock(side_effect=list(raws))
        scorer = AsyncMock(side_effect=[3.0, 8.0, 5.0, 6.0])
        with patch.object(agent, "_call_attacker_llm", attacker), \
             patch.object(agent, "_score_candidate", scorer):
            chosen = await agent._tap_select_candidate(agent._strategy)
        assert chosen == raws[1]  # the score=8.0 candidate

    @pytest.mark.asyncio
    async def test_score_prune_threshold_drops_low_candidates(self):
        agent = _make_agent(width=4, prune_threshold=5.0, on_topic_filter=False)
        raws = [_candidate_raw(f"c{i}") for i in range(4)]
        attacker = AsyncMock(side_effect=list(raws))
        scorer = AsyncMock(side_effect=[2.0, 4.0, 7.0, 9.0])
        with patch.object(agent, "_call_attacker_llm", attacker), \
             patch.object(agent, "_score_candidate", scorer):
            chosen = await agent._tap_select_candidate(agent._strategy)
        assert chosen == raws[3]  # only 7.0 and 9.0 survived; 9.0 wins

    @pytest.mark.asyncio
    async def test_on_topic_filter_drops_off_topic_candidates(self):
        agent = _make_agent(width=4, on_topic_filter=True, prune_threshold=0.0)
        raws = [_candidate_raw(f"c{i}") for i in range(4)]
        attacker = AsyncMock(side_effect=list(raws))
        # Candidates 0 and 2 are off-topic
        on_topic = AsyncMock(side_effect=[False, True, False, True])
        # Scorer is only called for on-topic survivors
        scorer = AsyncMock(side_effect=[6.0, 8.0])
        with patch.object(agent, "_call_attacker_llm", attacker), \
             patch.object(agent, "_is_on_topic", on_topic), \
             patch.object(agent, "_score_candidate", scorer):
            chosen = await agent._tap_select_candidate(agent._strategy)
        assert on_topic.await_count == 4
        assert scorer.await_count == 2  # only on-topic survivors scored
        assert chosen == raws[3]  # 8.0 > 6.0

    @pytest.mark.asyncio
    async def test_all_pruned_falls_back_to_single_call(self, caplog):
        agent = _make_agent(width=3, on_topic_filter=True, prune_threshold=5.0)
        branch_raws = [_candidate_raw(f"c{i}") for i in range(3)]
        fallback_raw = _candidate_raw("fallback")
        # 3 branches + 1 fallback call = 4 attacker calls total
        attacker = AsyncMock(side_effect=[*branch_raws, fallback_raw])
        # All off-topic → all pruned by on-topic filter (scorer never called)
        on_topic = AsyncMock(return_value=False)
        scorer = AsyncMock()
        with caplog.at_level(logging.WARNING, logger="scenario"):
            with patch.object(agent, "_call_attacker_llm", attacker), \
                 patch.object(agent, "_is_on_topic", on_topic), \
                 patch.object(agent, "_score_candidate", scorer):
                chosen = await agent._tap_select_candidate(agent._strategy)
        assert chosen == fallback_raw
        assert attacker.await_count == 4
        assert scorer.await_count == 0
        assert any("all 3 candidates pruned" in r.message for r in caplog.records)

    @pytest.mark.asyncio
    async def test_attacker_branch_exception_is_skipped(self):
        """One branch raising shouldn't kill the whole turn."""
        agent = _make_agent(width=3, on_topic_filter=False, prune_threshold=0.0)
        good_raw = _candidate_raw("ok")
        attacker = AsyncMock(side_effect=[
            RuntimeError("transient"), good_raw, _candidate_raw("low"),
        ])
        scorer = AsyncMock(side_effect=[8.0, 2.0])
        with patch.object(agent, "_call_attacker_llm", attacker), \
             patch.object(agent, "_score_candidate", scorer):
            chosen = await agent._tap_select_candidate(agent._strategy)
        assert chosen == good_raw


# ---------------------------------------------------------------------------
# _score_candidate / _is_on_topic — the helpers themselves
# ---------------------------------------------------------------------------


class TestScoreCandidate:
    @pytest.mark.asyncio
    async def test_parses_score_from_json(self):
        agent = _make_agent()
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = '{"score": 7}'
        with patch("scenario.red_team_agent.litellm.acompletion",
                   new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = mock_response
            score = await agent._score_candidate("some candidate")
        assert score == 7.0

    @pytest.mark.asyncio
    async def test_clamps_out_of_range(self):
        agent = _make_agent()
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = '{"score": 99}'
        with patch("scenario.red_team_agent.litellm.acompletion",
                   new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = mock_response
            score = await agent._score_candidate("c")
        assert score == 10.0

    @pytest.mark.asyncio
    async def test_returns_zero_for_empty_candidate(self):
        agent = _make_agent()
        # No LLM patch needed — empty short-circuits before any call
        score = await agent._score_candidate("")
        assert score == 0.0

    @pytest.mark.asyncio
    async def test_falls_back_to_zero_on_bad_json(self):
        agent = _make_agent()
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "garbage"
        with patch("scenario.red_team_agent.litellm.acompletion",
                   new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = mock_response
            score = await agent._score_candidate("c")
        assert score == 0.0


class TestIsOnTopic:
    @pytest.mark.asyncio
    async def test_yes_returns_true(self):
        agent = _make_agent()
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "Yes."
        with patch("scenario.red_team_agent.litellm.acompletion",
                   new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = mock_response
            assert await agent._is_on_topic("relevant message") is True

    @pytest.mark.asyncio
    async def test_no_returns_false(self):
        agent = _make_agent()
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "no, because ..."
        with patch("scenario.red_team_agent.litellm.acompletion",
                   new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = mock_response
            assert await agent._is_on_topic("off topic") is False

    @pytest.mark.asyncio
    async def test_empty_candidate_is_off_topic(self):
        agent = _make_agent()
        assert await agent._is_on_topic("") is False

    @pytest.mark.asyncio
    async def test_unparseable_defaults_to_on_topic(self):
        """Conservative default — don't silently drop everything on a flaky judge."""
        agent = _make_agent()
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "maybe?"
        with patch("scenario.red_team_agent.litellm.acompletion",
                   new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = mock_response
            assert await agent._is_on_topic("ambiguous") is True
