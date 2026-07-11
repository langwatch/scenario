---
id: audit
kind: procedure
keywords: [audit, record, log, change, ledger, meta, always]
links: [audit-record, done, escalate-ticket]
status: active
always_enforced: true
---
# Record What Was Changed Before Finishing

## Purpose
This meta-procedure describes how to record a durable audit-log entry of what a task changed before the task is finished. It exists so the history of changes stays reconstructable every time, regardless of who ran the task, and so a later auditor can retrace what was done without asking the operator. It is always in force: it governs every task that changes project state, not only the requests that name it.

## When this applies
- Use this before finishing any task that changed project state.
- Use this whenever a change would need to be retraced or reversed later.
- Use this when a reviewer or auditor must reconstruct what happened from the record alone.

## Procedure
1. Identify every change this task made to project state.
2. Write an audit-log entry that records each change, its target, and the reason for it.
3. Confirm the audit-log entry is durable and reconstructable before finishing.

## Verification
Confirm the audit-log entry names every change the task made, points each one at its target, and gives the reason, so a later auditor can retrace the task from the entry alone.

## Failure modes
- Watch for the case where a change is applied to state but never recorded, leaving the history incomplete; if it occurs, write the missing entry before finishing.
- Watch for the case where the entry records that something changed but not why; if it occurs, add the reason so the record is reconstructable.

## Related procedures
- `audit-record`
- `done`
- `escalate-ticket`
