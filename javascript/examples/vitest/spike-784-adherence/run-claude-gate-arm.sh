#!/usr/bin/env bash
# sc#784 Claude-gate parity batch — ONE arm. Owner constraints honored:
#  - shipped gate on a CLAUDE model via OAuth (ADHERENCE_GATE_MODEL=$1); referee/final judge stays gpt-5.1.
#  - always-enforced tier OFF (parity vs the pre-fold 11 recorded gpt-5.1 decisions).
#  - DATA FIRST (owner HOLD): telemetry keyed to the MCP-readable project (query-back proven);
#    raw artifacts copied to durable run-data/ the instant the run process exits (Gate B).
# Usage: run-claude-gate-arm.sh <gate-model>   e.g. claude-haiku-4-5 | claude-sonnet-4-5
set -uo pipefail
ARM="${1:?gate model required}"
SPIKE=/home/ubuntu/langwatch-workspace/scenario-784-adherence/javascript/examples/vitest/spike-784-adherence
DEST="$SPIKE/run-data/claude-gate/$ARM"
RUNLOG="$DEST/result.txt"
mkdir -p "$DEST"

# MCP-project key (sk-lw) — the project the LangWatch MCP reads, so simulations + judge
# spans are QUERY-BACK-able (Gate A/C proven). Sourced at runtime; never committed.
MCP_KEY="$(jq -r '.mcpServers.langwatch.args[] | select(startswith("sk-lw-"))' /home/ubuntu/.claude.json 2>/dev/null | head -1)"

echo "=== sc784 Claude-gate arm=$ARM @ $(date -u +%H:%M:%SZ) ===" | tee "$RUNLOG"
echo "dest(run-data): $DEST" | tee -a "$RUNLOG"
echo "gate=$ARM (OAuth/Claude) | referee-judge=gpt-5.1 | always-enforced=OFF | subject=claude-haiku-4-5" | tee -a "$RUNLOG"
echo "MCP key: $([ -n "$MCP_KEY" ] && echo yes-len${#MCP_KEY} || echo NO)" | tee -a "$RUNLOG"

SBOX_PARENT="${TMPDIR:-/tmp}/adherence-784-sandboxes"; mkdir -p "$SBOX_PARENT"
BEFORE="$(ls -1 "$SBOX_PARENT" 2>/dev/null | sort)"

cd "$SPIKE" || { echo "FATAL cd" | tee -a "$RUNLOG"; exit 90; }

# Cheap Haiku subject frees the Max bucket for the Claude gate; gate parity is subject-invariant
# (recorded set incl. a haiku-subject run, same decisions). Referee judge + user-sim on gpt-5.1/OpenAI.
ADHERENCE_SCENARIO=context-load-vendor \
ADHERENCE_GATE_MODEL="$ARM" \
ADHERENCE_ALWAYS_ENFORCED=0 \
ADHERENCE_SUBJECT_MODEL=claude-haiku-4-5 \
ADHERENCE_JUDGE_MODEL=gpt-5.1 \
LANGWATCH_API_KEY="$MCP_KEY" \
LANGWATCH_INGESTION_KEY="$MCP_KEY" \
timeout -k 60 1200 npx tsx run-h3.ts >>"$RUNLOG" 2>&1
RUN_EXIT=$?
echo "RUN_EXIT=$RUN_EXIT" | tee -a "$RUNLOG"

# --- Gate B: retain raw artifacts to run-data/ THE INSTANT the process is gone (before any cleanup) ---
AFTER="$(ls -1 "$SBOX_PARENT" 2>/dev/null | sort)"
NEWSBOX="$(comm -13 <(echo "$BEFORE") <(echo "$AFTER") | tail -1)"
[ -z "$NEWSBOX" ] && NEWSBOX="$(grep -oE 'adherence-784-sandboxes/[^ ]+' "$RUNLOG" | head -1 | sed 's#.*adherence-784-sandboxes/##')"
SB="$SBOX_PARENT/$NEWSBOX"
echo "sandbox: $SB" | tee -a "$RUNLOG"
# Copy ONLY secret-free raw artifacts (NEVER the .claude secrets: settings.local.json sk-lw, .claude.json oauth).
cp "$SB/checkpoint.json"                  "$DEST/checkpoint.json"     2>/dev/null && echo "retained checkpoint.json" | tee -a "$RUNLOG"
cp "$SB/.claude/adherence/hook-events.jsonl" "$DEST/hook-events.jsonl" 2>/dev/null && echo "retained hook-events.jsonl (gate decisions)" | tee -a "$RUNLOG"
cp "$SB/.claude/adherence/last-sheet.txt" "$DEST/last-sheet.txt"      2>/dev/null && echo "retained last-sheet.txt (compiled sheet)" | tee -a "$RUNLOG"
SUB="$(ls "$SB"/.claude/projects/*/*.jsonl 2>/dev/null | head -1)"
[ -n "$SUB" ] && cp "$SUB" "$DEST/substrate.jsonl" 2>/dev/null && echo "retained substrate.jsonl (stream JSONL)" | tee -a "$RUNLOG"

echo "" | tee -a "$RUNLOG"
echo "### GATE B verify — artifacts present in run-data/? ###" | tee -a "$RUNLOG"
for a in checkpoint.json hook-events.jsonl last-sheet.txt substrate.jsonl result.txt; do
  if [ -s "$DEST/$a" ]; then echo "  OK  $a ($(wc -c <"$DEST/$a") bytes)" | tee -a "$RUNLOG"; else echo "  MISSING $a" | tee -a "$RUNLOG"; fi
done
echo "### secret-scan run-data arm (must be clean) ###" | tee -a "$RUNLOG"
if grep -rlE 'sk-lw-[A-Za-z0-9]{6}|oauthAccount|access_token"|Bearer [A-Za-z0-9]{12}' "$DEST" 2>/dev/null; then echo "  !! SECRET IN run-data — DO NOT COMMIT" | tee -a "$RUNLOG"; else echo "  CLEAN" | tee -a "$RUNLOG"; fi

echo "" | tee -a "$RUNLOG"
echo "### PARITY EVIDENCE (gate arm=$ARM) ###" | tee -a "$RUNLOG"
echo "gateModel logged in hook events:" | tee -a "$RUNLOG"
grep -oE '"gateModel":"[^"]*"' "$DEST/hook-events.jsonl" 2>/dev/null | sort | uniq -c | tee -a "$RUNLOG"
echo "decision sequence:" | tee -a "$RUNLOG"
python3 - "$DEST/hook-events.jsonl" <<'PY' 2>/dev/null | tee -a "$RUNLOG"
import json,sys
try: rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
except Exception as e: print("(no hook-events)"); sys.exit()
fires=[e for e in rows if e.get("event")=="stop"]
print("  ["+", ".join(e.get("decision","?") for e in fires)+"]")
for e in fires:
    if e.get("decision")=="block" or e.get("blockedProcs"):
        print(f"    {e.get('decision')}: blocked={e.get('blockedProcs')} via={e.get('enforcedVia')} gate={e.get('gateModel')}")
PY
echo "final adherence (referee gpt-5.1):" | tee -a "$RUNLOG"
grep -oE 'action adherence \.+ [0-9/]+ = [0-9.]+|"status": "[a-z]+"' "$DEST/checkpoint.json" "$RUNLOG" 2>/dev/null | tail -3 | tee -a "$RUNLOG"
echo "DONE_MARKER claude-gate arm=$ARM exit=$RUN_EXIT"
