"""Streamlit dashboard for red-team scenario reports.

Run with:
    streamlit run python/scenario/report/app.py -- --batch-dir ./redteam-reports/<ts>/

If ``--batch-dir`` is omitted, the app picks the most recent directory
under ``./redteam-reports/``.
"""

from __future__ import annotations

import argparse
import html
import json
import sys
from pathlib import Path

import streamlit as st  # pyright: ignore[reportMissingImports]
import plotly.graph_objects as go  # pyright: ignore[reportMissingImports]


_SEVERITY_ORDER = ["critical", "high", "medium", "low"]
_SEVERITY_COLOR = {
    "critical": "#b3261e",
    "high":     "#e8781a",
    "medium":   "#d4a017",
    "low":      "#0f8043",
}

_BREAK_ORDER = ["complete", "significant", "partial", "none"]

# Compound risk matrix: severity (ceiling) × break_severity (actual outcome)
# Rows = severity, columns = break_severity.
_COMPOUND_MATRIX: dict[tuple[str, str], str] = {
    ("critical", "none"):        "none",
    ("critical", "partial"):     "high",
    ("critical", "significant"): "critical",
    ("critical", "complete"):    "critical",
    ("high",     "none"):        "none",
    ("high",     "partial"):     "medium",
    ("high",     "significant"): "high",
    ("high",     "complete"):    "high",
    ("medium",   "none"):        "none",
    ("medium",   "partial"):     "low",
    ("medium",   "significant"): "medium",
    ("medium",   "complete"):    "medium",
    ("low",      "none"):        "none",
    ("low",      "partial"):     "low",
    ("low",      "significant"): "low",
    ("low",      "complete"):    "low",
}

_RISK_ORDER = ["critical", "high", "medium", "low", "none"]
_RISK_COLOR = {
    "critical": "#b3261e",
    "high":     "#e8781a",
    "medium":   "#d4a017",
    "low":      "#3b82f6",
    "none":     "#0f8043",
}


def _severity_of(report: dict) -> str:
    """Return the LLM-assigned scenario severity (inherent risk ceiling).
    Defaults to 'medium' if missing."""
    s = (report.get("severity") or "").lower().strip()
    return s if s in _SEVERITY_ORDER else "medium"


def _break_of(report: dict) -> str:
    """Return how badly the agent broke on this specific run.
    Defaults: 'none' if held, 'partial' if broke, 'none' if errored (no verdict)."""
    b = (report.get("break_severity") or "").lower().strip()
    if b in _BREAK_ORDER:
        return b
    status = report.get("status") or ("held" if report.get("success") else "broke")
    if status == "held":
        return "none"
    if status == "broke":
        return "partial"
    return "none"


def _compound_risk(report: dict) -> str:
    """Primary urgency metric: severity × break_severity → single label.
    Errored runs (no verdict) fall back to scenario severity as 'unresolved'."""
    status = report.get("status") or ("held" if report.get("success") else "broke")
    if status == "errored":
        return _severity_of(report)
    return _COMPOUND_MATRIX.get((_severity_of(report), _break_of(report)), "low")


# ---------------------------------------------------------------------------
# CLI / data loading
# ---------------------------------------------------------------------------


def _parse_cli_batch_dir() -> Path | None:
    argv = sys.argv[1:]
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch-dir", type=str, default=None)
    parser.add_argument("batch_dir_pos", nargs="?", default=None)
    args, _ = parser.parse_known_args(argv)
    path = args.batch_dir or args.batch_dir_pos
    return Path(path).resolve() if path else None


def _discover_batch_dirs(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return sorted(
        (p for p in root.iterdir() if p.is_dir()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )


def _load_reports(batch_dir: Path) -> list[dict]:
    out: list[dict] = []
    for f in sorted(batch_dir.glob("*.json")):
        if f.name.startswith("_"):
            continue  # skip cached meta files like _aggregated_fixes.json
        try:
            out.append(json.loads(f.read_text()))
        except Exception as e:
            st.warning(f"Skipped {f.name}: {e}")
    return out


def _status(r: dict) -> str:
    return r.get("status") or ("held" if r.get("success") else "broke")


def _pretty_test_name(s: str) -> str:
    words = s.replace("_", " ").split()
    fixed = []
    for w in words:
        lo = w.lower()
        if lo in {"pii", "api", "url", "sql", "sms", "dob", "ssn", "id"}:
            fixed.append(w.upper())
        else:
            fixed.append(w.capitalize())
    return " ".join(fixed)


# ---------------------------------------------------------------------------
# Message helpers
# ---------------------------------------------------------------------------


def _message_text(m: dict) -> str:
    content = m.get("content", "")
    if isinstance(content, list):
        parts = []
        for c in content:
            if isinstance(c, dict):
                parts.append(c.get("text", "") or "")
            else:
                parts.append(str(c))
        content = " ".join(p for p in parts if p)
    if not content and m.get("tool_calls"):
        names = []
        for c in m["tool_calls"] if isinstance(m.get("tool_calls"), list) else []:
            fn = c.get("function", {}) if isinstance(c, dict) else {}
            names.append(fn.get("name", "tool"))
        content = f"[tool_call: {', '.join(names)}]"
    return str(content or "").strip()


def _turns_with_messages(messages: list[dict]) -> list[tuple[int, dict]]:
    out: list[tuple[int, dict]] = []
    turn = 0
    for m in messages:
        role = m.get("role", "")
        if role == "user":
            turn += 1
        if role in ("user", "assistant", "tool"):
            out.append((turn, m))
    return out


def _turn_pair(messages: list[dict], target_turn: int) -> tuple[str, str]:
    """Return (attacker_text, agent_text) for the given turn."""
    attacker = ""
    agent = ""
    for turn, m in _turns_with_messages(messages):
        if turn != target_turn:
            continue
        role = m.get("role")
        text = _message_text(m)
        if role == "user" and not attacker:
            attacker = text
        elif role == "assistant" and not agent:
            agent = text
    return attacker, agent


def _last_full_turn(messages: list[dict]) -> int | None:
    """Find the last turn where both user and assistant messages exist."""
    seen_user = set()
    seen_agent = set()
    for turn, m in _turns_with_messages(messages):
        role = m.get("role")
        if role == "user":
            seen_user.add(turn)
        elif role == "assistant":
            seen_agent.add(turn)
    complete = sorted(seen_user & seen_agent)
    return complete[-1] if complete else None


# ---------------------------------------------------------------------------
# Styles — explicit colors, theme-independent
# ---------------------------------------------------------------------------


_PRIORITY_COLORS = {
    "high":   ("#fdecec", "#c1261e", "#b3261e"),  # bg, text, accent
    "medium": ("#fef7e0", "#92400e", "#d4a017"),
    "low":    ("#eef4fb", "#1e40af", "#3b82f6"),
}


_STYLES = """
<style>
.block-container { padding-top: 2rem; padding-bottom: 3rem; max-width: 1200px; }
.stApp { background: #f6f7f9; }

/* Header */
.rt-header { margin-bottom: 8px; }
.rt-header h1 { color: #0f172a; font-weight: 700; letter-spacing: -0.02em; margin: 0; }
.rt-header .subtitle { color: #64748b; font-size: 13px; margin-top: 4px; }

/* Summary strip */
.rt-summary {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;
  margin: 16px 0 28px 0;
}
.rt-summary .metric {
  background: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px;
  padding: 14px 16px;
}
.rt-summary .metric .label {
  font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
  color: #64748b; font-weight: 600;
}
.rt-summary .metric .value {
  font-size: 28px; font-weight: 700; color: #0f172a; margin-top: 4px; line-height: 1;
}
.rt-summary .metric.held .value { color: #0f8043; }
.rt-summary .metric.broke .value { color: #c1261e; }
.rt-summary .metric.err .value { color: #64748b; }

/* Risk overview — donut + test checklist side by side */
.rt-overview {
  background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px;
  padding: 24px 28px; margin-bottom: 28px;
  display: grid; grid-template-columns: 220px 1fr; gap: 32px; align-items: center;
}
.rt-donut-wrap { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.rt-donut-caption { font-size: 12px; color: #64748b; text-align: center; line-height: 1.4; }
.rt-donut-caption .fail { color: #c1261e; font-weight: 700; }
.rt-donut-title { font-size: 14px; font-weight: 700; color: #0f172a; text-align: center; }

.rt-checklist { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; }
.rt-check-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 0; font-size: 13.5px; color: #0f172a;
  border-bottom: 1px solid #f1f5f9;
}
.rt-check-item:last-child { border-bottom: none; }
.rt-check-item .icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border-radius: 50%; color: #fff; font-weight: 700;
  font-size: 13px; flex-shrink: 0;
}
.rt-check-item .icon.pass { background: #0f8043; }
.rt-check-item .icon.fail { background: #c1261e; }
.rt-check-item .icon.err  { background: #94a3b8; }

/* Section headers */
.rt-section-title {
  font-size: 13px; color: #64748b; letter-spacing: 0.08em; text-transform: uppercase;
  font-weight: 700; margin: 28px 0 12px 0;
}
.rt-section-title.broke { color: #c1261e; }
.rt-section-title.held { color: #0f8043; }

/* Unified finding card */
.rt-finding {
  background: #ffffff; border: 1px solid #e2e8f0; border-left: 4px solid #94a3b8;
  border-radius: 12px; padding: 20px 22px; margin-bottom: 18px;
  box-shadow: 0 1px 3px rgba(16,24,40,0.05);
}
.rt-finding.broke  { border-color: #e8b5b1; border-left-color: #c1261e; }
.rt-finding.held   { border-color: #c4e5d1; border-left-color: #0f8043; }
.rt-finding.errored { border-color: #cbd5e1; border-left-color: #64748b; }
.rt-finding .head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px; gap: 12px; }
.rt-finding .title { font-size: 19px; font-weight: 700; color: #0f172a; line-height: 1.25; }
.rt-finding .meta { font-size: 12px; color: #64748b; margin-top: 4px; }
.rt-finding .summary { font-size: 14px; color: #1f2937; margin: 14px 0; line-height: 1.5; }

.rt-finding .section-label {
  font-size: 11px; color: #64748b; letter-spacing: 0.08em; text-transform: uppercase;
  font-weight: 700; margin: 18px 0 8px 0;
}

.rt-exchange { background: #fafbfc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 14px; }
.rt-exchange .line { margin-bottom: 10px; }
.rt-exchange .line:last-child { margin-bottom: 0; }
.rt-exchange .role { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 700; margin-bottom: 4px; }
.rt-exchange .role.attacker { color: #c1261e; }
.rt-exchange .role.agent { color: #1e40af; }
.rt-exchange .role.agent-held { color: #0f8043; }
.rt-exchange .text { font-size: 13.5px; color: #0f172a; line-height: 1.5; white-space: pre-wrap; }

.rt-suggestions { margin: 4px 0 0 0; padding-left: 20px; color: #0f172a; font-size: 13.5px; line-height: 1.6; }

/* Status chips */
.rt-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.rt-chip {
  display: inline-block; padding: 3px 10px; border-radius: 999px;
  font-size: 11px; font-weight: 700; letter-spacing: 0.04em;
}
.rt-chip.strategy { background: #eef2ff; color: #3730a3; }
.rt-chip.turns { background: #f1f5f9; color: #334155; }
.rt-chip.broke { background: #fee2e2; color: #991b1b; }
.rt-chip.held  { background: #dcfce7; color: #166534; }
.rt-chip.errored { background: #e2e8f0; color: #334155; }
.rt-chip.failturn { background: #fef3c7; color: #92400e; }

/* Held chip (compact) */
.rt-held-chip {
  background: #ffffff; border: 1px solid #d1e7dd; border-left: 4px solid #0f8043;
  border-radius: 10px; padding: 12px 14px;
  display: flex; flex-direction: column; gap: 6px;
  height: 100%;
}
.rt-held-chip .t { font-weight: 600; font-size: 14px; color: #0f172a; }
.rt-held-chip .m { font-size: 11px; color: #64748b; }
.rt-held-chip .s { font-size: 12px; color: #334155; line-height: 1.4; margin-top: 4px; }

/* Transcript */
.rt-msg { border-radius: 8px; padding: 10px 12px; margin: 6px 0; color: #0f172a; }
.rt-msg .label { font-size: 10px; color: #64748b; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 4px; font-weight: 700; }
.rt-msg .body  { font-size: 13.5px; white-space: pre-wrap; color: #0f172a; line-height: 1.5; }
.rt-msg.user      { background: #eef4ff; border: 1px solid #c7d7f5; }
.rt-msg.assistant { background: #f6f8fa; border: 1px solid #e0e4e8; }
.rt-msg.tool      { background: #fffaf0; border: 1px solid #f0e6d2; }
.rt-msg.failing   { background: #fff4b3; border: 2px solid #d4a017; }
.rt-msg.failing .label { color: #92400e; }

/* Section spacing */
.rt-gap { height: 18px; }

/* Prioritized fixes */
.rt-fix {
  background: #ffffff; border: 1px solid #e2e8f0;
  border-radius: 12px; padding: 16px 20px; margin-bottom: 12px;
  border-left: 4px solid #3b82f6;
}
.rt-fix.high   { border-left-color: #b3261e; }
.rt-fix.medium { border-left-color: #d4a017; }
.rt-fix.low    { border-left-color: #3b82f6; }

.rt-fix .row { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; }
.rt-fix .title { font-size: 16px; font-weight: 700; color: #0f172a; }
.rt-fix .desc  { font-size: 13.5px; color: #334155; margin-top: 6px; line-height: 1.5; }
.rt-fix .rollup { font-size: 12px; color: #64748b; margin-top: 10px; }

.rt-fix-priority {
  display: inline-block; padding: 3px 10px; border-radius: 999px;
  font-size: 11px; font-weight: 700; letter-spacing: 0.04em; white-space: nowrap;
}
.rt-fix-priority.high   { background: #fdecec; color: #b3261e; }
.rt-fix-priority.medium { background: #fef7e0; color: #92400e; }
.rt-fix-priority.low    { background: #eef4fb; color: #1e40af; }

.rt-fix .affected {
  font-size: 11px; color: #64748b; margin-top: 8px;
  text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600;
}
.rt-fix .affected .tag {
  display: inline-block; background: #f1f5f9; color: #334155;
  padding: 2px 8px; border-radius: 999px;
  margin: 0 4px 4px 0; text-transform: none; letter-spacing: 0;
  font-weight: 500; font-size: 11px;
}
</style>
"""


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def _pill(cls: str, text: str) -> str:
    return f'<span class="rt-chip {cls}">{html.escape(text)}</span>'


def _render_finding(report: dict) -> None:
    """Unified big-panel card for any run, held / broke / errored."""
    status = _status(report)
    test_name = _pretty_test_name(report.get("test_name") or "")
    strategy = (report.get("strategy") or "?").upper()
    turns = report.get("total_turns", "?")
    summary = report.get("failure_summary") or report.get("reasoning") or ""
    elapsed = report.get("total_time")
    attacker_model = report.get("attacker_model", "")
    messages = report.get("messages") or []
    suggestions = report.get("suggestions") or []

    # Which turn to spotlight?
    # - broke: the failing turn
    # - held:  the last complete turn as a defense example
    # - errored: none
    if status == "broke":
        spotlight_turn = report.get("failing_turn_index")
    elif status == "held":
        spotlight_turn = _last_full_turn(messages)
    else:
        spotlight_turn = None

    # Header labels / chips: compound risk is the headline, severity + break are
    # secondary chips that justify it.
    severity = _severity_of(report)
    break_sev = _break_of(report)
    risk = _compound_risk(report)
    risk_color = _RISK_COLOR[risk]
    risk_chip = (
        f'<span class="rt-chip" style="background:{risk_color};color:#fff;">'
        f'RISK · {html.escape(risk.upper())}</span>'
    )
    sev_color = _SEVERITY_COLOR[severity]
    severity_chip = (
        f'<span class="rt-chip" style="background:{sev_color}22;color:{sev_color};'
        f'border:1px solid {sev_color}55;">SCENARIO · {html.escape(severity.upper())}</span>'
    )
    break_chip = (
        f'<span class="rt-chip" style="background:#f1f5f9;color:#334155;'
        f'border:1px solid #cbd5e1;">BREAK · {html.escape(break_sev.upper())}</span>'
    )
    status_chip_label = {"held": "HELD", "broke": "COMPROMISED", "errored": "ERRORED"}[status]
    chips = [risk_chip, severity_chip, break_chip, _pill("strategy", strategy), _pill(status, status_chip_label)]

    meta_bits = []
    if status == "broke" and spotlight_turn:
        meta_bits.append(f"Failed at turn {spotlight_turn} of {turns}")
        chips.append(_pill("failturn", f"Turn {spotlight_turn}"))
    elif status == "held":
        meta_bits.append(f"Held across {turns} turns")
    else:
        meta_bits.append(f"{turns} turns")
    if elapsed is not None:
        meta_bits.append(f"{elapsed:.0f}s")
    if attacker_model:
        meta_bits.append(attacker_model)
    meta = " · ".join(meta_bits)

    # Example exchange block — only render if we have actual content
    exchange_html = ""
    if spotlight_turn and status in ("broke", "held"):
        attacker_text, agent_text = _turn_pair(messages, spotlight_turn)
        parts = []
        if attacker_text:
            attacker_label = (
                f"Attacker · Turn {spotlight_turn}"
                if status == "broke"
                else f"Attacker's final push · Turn {spotlight_turn}"
            )
            parts.append(
                f'<div class="line"><div class="role attacker">{html.escape(attacker_label)}</div>'
                f'<div class="text">{html.escape(attacker_text[:600])}</div></div>'
            )
        if agent_text:
            agent_cls = "agent-held" if status == "held" else "agent"
            agent_label = "Agent's defensive response" if status == "held" else "Agent response"
            parts.append(
                f'<div class="line"><div class="role {agent_cls}">{html.escape(agent_label)}</div>'
                f'<div class="text">{html.escape(agent_text[:600])}</div></div>'
            )
        if parts:
            section_label = (
                "The breaking exchange" if status == "broke" else "Example of the defense in action"
            )
            exchange_html = (
                f'<div class="section-label">{section_label}</div>'
                f'<div class="rt-exchange">{"".join(parts)}</div>'
            )

    # Suggestions / what-worked block
    suggestions_html = ""
    if suggestions:
        top3 = suggestions[:3]
        items = "".join(f"<li>{html.escape(str(s))}</li>" for s in top3)
        section_label = (
            "Top fixes to harden the agent"
            if status == "broke"
            else "Defensive patterns to preserve"
            if status == "held"
            else "Error context"
        )
        suggestions_html = (
            f'<div class="section-label">{section_label}</div>'
            f'<ul class="rt-suggestions">{items}</ul>'
        )

    st.markdown(
        f"""
        <div class="rt-finding {status}">
          <div class="head">
            <div>
              <div class="title">{html.escape(test_name)}</div>
              <div class="meta">{html.escape(meta)}</div>
            </div>
            <div class="rt-chips">{"".join(chips)}</div>
          </div>
          <div class="summary">{html.escape(summary)}</div>
          {exchange_html}
          {suggestions_html}
        </div>
        """,
        unsafe_allow_html=True,
    )

    with st.expander("Full details · transcript · all suggestions"):
        _render_full_detail(report)


def _render_transcript(messages: list[dict], failing_turn: int | None) -> None:
    for turn, m in _turns_with_messages(messages):
        role = m.get("role", "?")
        text = _message_text(m)
        if not text:
            continue
        is_failing = failing_turn is not None and turn == failing_turn
        classes = ["rt-msg", role]
        if is_failing:
            classes.append("failing")
        label = {
            "user": f"Turn {turn} · attacker",
            "assistant": f"Turn {turn} · agent",
            "tool": f"Turn {turn} · tool",
        }.get(role, f"Turn {turn} · {role}")
        if is_failing:
            label += " · FAILING TURN"
        st.markdown(
            f'<div class="{" ".join(classes)}">'
            f'<div class="label">{html.escape(label)}</div>'
            f'<div class="body">{html.escape(text)}</div></div>',
            unsafe_allow_html=True,
        )


def _render_full_detail(report: dict) -> None:
    target = report.get("target", "")
    if target:
        st.markdown(f"**Target of attack**  \n{target}")

    criteria = report.get("criteria") or []
    if criteria:
        st.markdown("**Criteria the agent had to satisfy**")
        for c in criteria:
            st.markdown(f"- {c}")

    reasoning = report.get("reasoning") or ""
    if reasoning:
        st.markdown("**Judge reasoning**")
        st.info(reasoning)

    sev_rat = report.get("severity_rationale") or ""
    brk_rat = report.get("break_rationale") or ""
    if sev_rat or brk_rat:
        st.markdown("**Risk breakdown**")
        risk = _compound_risk(report)
        st.markdown(
            f"- **Compound risk:** `{risk.upper()}` "
            f"(scenario `{_severity_of(report).upper()}` × break `{_break_of(report).upper()}`)"
        )
        if sev_rat:
            st.markdown(f"- **Why scenario severity:** {sev_rat}")
        if brk_rat:
            st.markdown(f"- **Why break severity:** {brk_rat}")

    suggestions = report.get("suggestions") or []
    if suggestions:
        st.markdown("**All suggestions**")
        for s in suggestions:
            st.markdown(f"- {s}")

    st.markdown("**Full transcript**")
    _render_transcript(report.get("messages") or [], report.get("failing_turn_index"))


def _risk_donut_figure(actionable: list[dict]) -> go.Figure:
    """Plotly donut split by COMPOUND RISK of compromised/errored findings.

    Compound risk = severity × break_severity — the urgency score that
    accounts for both the stakes of the scenario AND how badly the agent
    actually failed on this run.
    """
    # Only show risk levels that would appear on actionable findings — skip 'none'
    # since anything with risk=none shouldn't be in this pool anyway.
    shown = ["critical", "high", "medium", "low"]
    by_risk = {r: 0 for r in shown}
    for r in actionable:
        level = _compound_risk(r)
        if level in by_risk:
            by_risk[level] += 1
    total = sum(by_risk.values())

    labels = [s.capitalize() for s in shown]
    values = [by_risk[s] for s in shown]
    colors = [_RISK_COLOR[s] for s in shown]

    fig = go.Figure(
        data=[
            go.Pie(
                labels=labels,
                values=values,
                hole=0.62,
                marker=dict(colors=colors, line=dict(color="#ffffff", width=2)),
                textinfo="none",
                hovertemplate="<b>%{label}</b><br>Count: %{value}<br>Rate: %{percent}<extra></extra>",
                sort=False,
                direction="clockwise",
            )
        ]
    )

    center_top = f"<b style='font-size:28px;color:#0f172a;'>{total}</b>"
    center_sub = "Open Findings" if total != 1 else "Open Finding"
    fig.update_layout(
        showlegend=False,
        margin=dict(l=0, r=0, t=0, b=0),
        height=240,
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        annotations=[
            dict(
                text=f"{center_top}<br><span style='font-size:11px;color:#64748b;'>{center_sub}</span>",
                x=0.5, y=0.5, showarrow=False, font=dict(size=14),
            )
        ],
    )
    return fig


def _compliance_donut_figure(held: int, total: int) -> go.Figure:
    """Simpler held-vs-not donut for overall compliance."""
    not_held = max(0, total - held)
    pct = round(100 * held / total) if total else 0
    fig = go.Figure(
        data=[
            go.Pie(
                labels=["Held", "Compromised/Errored"],
                values=[held, not_held],
                hole=0.65,
                marker=dict(colors=["#0f8043", "#eef1f5"], line=dict(color="#ffffff", width=2)),
                textinfo="none",
                hovertemplate="<b>%{label}</b><br>%{value} runs (%{percent})<extra></extra>",
                sort=False,
                direction="clockwise",
            )
        ]
    )
    fig.update_layout(
        showlegend=False,
        margin=dict(l=0, r=0, t=0, b=0),
        height=240,
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        annotations=[
            dict(
                text=f"<b style='font-size:28px;color:#0f172a;'>{pct}%</b><br>"
                     f"<span style='font-size:11px;color:#64748b;'>{held}/{total} held</span>",
                x=0.5, y=0.5, showarrow=False, font=dict(size=14),
            )
        ],
    )
    return fig


def _legend_row(items: list[tuple[str, str, int]]) -> str:
    """Render a horizontal legend row: [(label, color, count), ...]."""
    parts = []
    for label, color, count in items:
        parts.append(
            f'<span style="display:inline-flex;align-items:center;gap:6px;margin-right:16px;font-size:12px;color:#334155;">'
            f'<span style="display:inline-block;width:10px;height:10px;background:{color};border-radius:2px;"></span>'
            f'<b>{html.escape(label)}</b> <span style="color:#64748b;">{count}</span>'
            f"</span>"
        )
    return f'<div style="text-align:center;margin-top:8px;">{"".join(parts)}</div>'


def _render_overview(
    reports: list[dict],
    total: int,
    held: list[dict],
    broke: list[dict],
    errored: list[dict],
    compliance: int,
) -> None:
    """Two donuts (compliance + severity breakdown) + per-test checklist."""
    actionable = broke + errored

    # Two donuts side-by-side, checklist to the right
    c1, c2, c3 = st.columns([1, 1, 1.6])

    with c1:
        st.markdown(
            '<div style="text-align:center;font-size:14px;font-weight:700;color:#0f172a;margin-bottom:20px;">Defensive Compliance</div>',
            unsafe_allow_html=True,
        )
        st.plotly_chart(
            _compliance_donut_figure(len(held), total),
            use_container_width=True,
            config={"displayModeBar": False},
        )

    with c2:
        st.markdown(
            '<div style="text-align:center;font-size:14px;font-weight:700;color:#0f172a;margin-bottom:20px;">Open Findings by Risk</div>',
            unsafe_allow_html=True,
        )
        st.plotly_chart(
            _risk_donut_figure(actionable),
            use_container_width=True,
            config={"displayModeBar": False},
        )
        shown_risks = ["critical", "high", "medium", "low"]
        by_risk = {s: 0 for s in shown_risks}
        for r in actionable:
            level = _compound_risk(r)
            if level in by_risk:
                by_risk[level] += 1
        st.markdown(
            _legend_row([
                (s.capitalize(), _RISK_COLOR[s], by_risk[s])
                for s in shown_risks
            ]),
            unsafe_allow_html=True,
        )

    with c3:
        st.markdown(
            '<div style="font-size:14px;font-weight:700;color:#0f172a;margin-bottom:8px;">Per-test Outcomes</div>',
            unsafe_allow_html=True,
        )
        order = {"broke": 0, "errored": 1, "held": 2}
        sorted_reports = sorted(
            reports,
            key=lambda r: (order.get(_status(r), 9), r.get("test_name", "")),
        )
        item_html_parts = []
        for r in sorted_reports:
            s = _status(r)
            name = _pretty_test_name(r.get("test_name") or "")
            risk = _compound_risk(r)
            risk_color = _RISK_COLOR[risk]
            if s == "held":
                icon_cls, icon_char = "pass", "✓"
            elif s == "errored":
                icon_cls, icon_char = "err", "!"
            else:
                icon_cls, icon_char = "fail", "✗"
            risk_pill = (
                f'<span style="display:inline-block;background:{risk_color};color:#fff;'
                f'font-size:10px;font-weight:700;letter-spacing:0.04em;padding:1px 7px;'
                f'border-radius:999px;margin-right:8px;">{risk.upper()}</span>'
            )
            item_html_parts.append(
                f'<div class="rt-check-item">'
                f'<span>{risk_pill}{html.escape(name)}</span>'
                f'<span class="icon {icon_cls}">{icon_char}</span></div>'
            )
        st.markdown(
            "".join(item_html_parts),
            unsafe_allow_html=True,
        )


def _render_prioritized_fixes(batch_dir: Path, reports: list[dict]) -> None:
    """Cluster suggestions across findings and render a prioritized fix list."""
    # Only show if we have any compromised or errored runs (fixes matter there)
    actionable = [r for r in reports if _status(r) in ("broke", "errored")]
    if not actionable:
        return

    from scenario.report import load_or_generate_fixes

    cache_path = batch_dir / "_aggregated_fixes.json"

    st.markdown(
        '<div class="rt-section-title">Prioritized Fixes</div>',
        unsafe_allow_html=True,
    )

    # Generate button — only call LLM on explicit action, then cache
    col1, col2 = st.columns([4, 1])
    with col2:
        regen = st.button("Regenerate", help="Re-cluster fixes with a fresh LLM call")

    if not cache_path.exists() or regen:
        with st.spinner("Clustering suggestions across findings..."):
            try:
                load_or_generate_fixes(batch_dir, reports, force=regen)
            except Exception as e:
                st.error(f"Aggregation failed: {e}")
                return

    try:
        data = json.loads(cache_path.read_text())
    except Exception as e:
        st.error(f"Could not read aggregated fixes: {e}")
        return

    clusters = data.get("clusters") or []
    if not clusters:
        st.info("No aggregated fixes yet.")
        return

    order = {"high": 0, "medium": 1, "low": 2}
    clusters = sorted(
        clusters,
        key=lambda c: (order.get((c.get("priority") or "low").lower(), 9),
                       -int(c.get("recommendations_rolled_up") or 0)),
    )

    for c in clusters:
        priority = (c.get("priority") or "low").lower()
        if priority not in _PRIORITY_COLORS:
            priority = "low"
        title = c.get("title") or "(untitled fix)"
        desc = c.get("description") or ""
        count = c.get("recommendations_rolled_up") or 0
        affected = c.get("affected_tests") or []

        affected_html = ""
        if affected:
            tags = "".join(
                f'<span class="tag">{html.escape(_pretty_test_name(str(t)))}</span>'
                for t in affected
            )
            affected_html = f'<div class="affected">Affects · {tags}</div>'

        st.markdown(
            f"""
            <div class="rt-fix {priority}">
              <div class="row">
                <div>
                  <div class="title">{html.escape(title)}</div>
                  <div class="desc">{html.escape(desc)}</div>
                </div>
                <span class="rt-fix-priority {priority}">{priority.upper()} PRIORITY</span>
              </div>
              <div class="rollup">Rolled up from {count} suggestion{'s' if count != 1 else ''} across {len(affected)} finding{'s' if len(affected) != 1 else ''}</div>
              {affected_html}
            </div>
            """,
            unsafe_allow_html=True,
        )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    st.set_page_config(page_title="Red-Team Report", layout="wide")
    st.markdown(_STYLES, unsafe_allow_html=True)

    root = Path.cwd() / "redteam-reports"
    cli_dir = _parse_cli_batch_dir()
    available = _discover_batch_dirs(root)

    with st.sidebar:
        st.markdown("### Batch")
        if cli_dir is not None:
            batch_dir = cli_dir
            st.caption(f"`{cli_dir}`")
        elif available:
            options = [str(p) for p in available]
            labels = [p.name for p in available]
            idx = st.selectbox(
                "Select batch",
                list(range(len(options))),
                index=0,
                format_func=lambda i: labels[i],
            )
            batch_dir = Path(options[idx])
        else:
            st.error(f"No batch directories found under {root}")
            st.stop()
            return

    reports = _load_reports(batch_dir)
    if not reports:
        st.warning(f"No reports found in {batch_dir}")
        return

    total = len(reports)
    held = [r for r in reports if _status(r) == "held"]
    broke = [r for r in reports if _status(r) == "broke"]
    errored = [r for r in reports if _status(r) == "errored"]

    compliance = int(round(100 * len(held) / total)) if total else 0

    # Header
    st.markdown(
        f"""
        <div class="rt-header">
          <h1>Red-Team Audit</h1>
          <div class="subtitle">{html.escape(batch_dir.name)} · {total} run{'s' if total != 1 else ''}</div>
        </div>
        """,
        unsafe_allow_html=True,
    )

    # Overview — donut + per-test checklist
    _render_overview(reports, total, held, broke, errored, compliance)

    # Metric tiles strip
    st.markdown(
        f"""
        <div class="rt-summary">
          <div class="metric"><div class="label">Total runs</div><div class="value">{total}</div></div>
          <div class="metric held"><div class="label">Held</div><div class="value">{len(held)}</div></div>
          <div class="metric broke"><div class="label">Compromised</div><div class="value">{len(broke)}</div></div>
          <div class="metric err"><div class="label">Errored</div><div class="value">{len(errored)}</div></div>
        </div>
        """,
        unsafe_allow_html=True,
    )

    # Prioritized fixes — aggregated across all actionable findings
    _render_prioritized_fixes(batch_dir, reports)

    # Findings (compromised) — sort by compound risk descending (most urgent first)
    if broke:
        st.markdown(
            f'<div class="rt-section-title broke">{len(broke)} Finding{"s" if len(broke) != 1 else ""} Requiring Attention</div>',
            unsafe_allow_html=True,
        )
        risk_rank = {r: i for i, r in enumerate(_RISK_ORDER)}
        broke.sort(key=lambda r: (risk_rank.get(_compound_risk(r), 9), r.get("failing_turn_index") or 9_999))
        for r in broke:
            _render_finding(r)

    # Errored runs (infra failures, not attacks)
    if errored:
        st.markdown(
            f'<div class="rt-section-title">{len(errored)} Errored Run{"s" if len(errored) != 1 else ""}</div>',
            unsafe_allow_html=True,
        )
        for r in errored:
            _render_finding(r)

    # Held
    if held:
        st.markdown(
            f'<div class="rt-section-title held">{len(held)} Attack{"s" if len(held) != 1 else ""} Held — What Worked</div>',
            unsafe_allow_html=True,
        )
        for r in held:
            _render_finding(r)


if __name__ == "__main__":
    main()
