#!/usr/bin/env bash
#
# Polls GitHub Actions workflow status until all complete or timeout.
# Outputs JSON result for the agent to analyze.
#
# Usage: ./scripts/ci-wait.sh [branch] [timeout_seconds] [interval_seconds]
#

set -euo pipefail

BRANCH="${1:-$(git branch --show-current)}"
TIMEOUT="${2:-600}"
INTERVAL="${3:-30}"
ELAPSED=0

echo "Waiting for CI workflows on branch: $BRANCH"
echo "Timeout: ${TIMEOUT}s, Poll interval: ${INTERVAL}s"
echo ""

while [ $ELAPSED -lt $TIMEOUT ]; do
  RAW_RESULT=$(gh run list --branch "$BRANCH" --limit 20 --json status,conclusion,name,databaseId,workflowName,createdAt)
  
  # Get only the most recent run per workflow (dedupe by workflowName)
  RESULT=$(echo "$RAW_RESULT" | jq '[group_by(.workflowName) | .[] | sort_by(.createdAt) | reverse | .[0]]')
  
  # Check if any still running
  PENDING=$(echo "$RESULT" | jq '[.[] | select(.status == "in_progress" or .status == "queued")] | length')
  
  if [ "$PENDING" -eq 0 ]; then
    # Check for failures
    FAILED=$(echo "$RESULT" | jq '[.[] | select(.conclusion == "failure")] | length')
    
    if [ "$FAILED" -gt 0 ]; then
      echo "CI FAILED"
      echo ""
      echo "$RESULT" | jq '.[] | select(.conclusion == "failure") | {name, workflowName, databaseId}'
      exit 1
    else
      echo "CI PASSED"
      echo ""
      echo "$RESULT" | jq '.[] | {name, workflowName, conclusion}'
      exit 0
    fi
  fi
  
  echo "[$ELAPSED/${TIMEOUT}s] $PENDING workflow(s) still running..."
  sleep "$INTERVAL"
  ELAPSED=$((ELAPSED + INTERVAL))
done

echo "TIMEOUT after ${TIMEOUT}s"
echo "$RESULT" | jq '.[] | {name, status, conclusion}'
exit 2
