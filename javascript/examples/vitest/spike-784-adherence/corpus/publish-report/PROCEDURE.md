---
id: publish-report
kind: procedure
keywords: [publish, report, recovery, audited, runbook]
links: [escalate-ticket, decommission-service, reconfigure-service, rollback-service]
status: active
---
# Publish Report

## Purpose
This procedure describes how to make report available to its consumers under change control. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a scheduled maintenance window requires it.
- Use this when an alert indicates the target has degraded.
- Use this when a request from an owner has been approved.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] You have the authorization required for this operation.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The change window is open and stakeholders have been informed.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The rollback path has been identified and is known to work.

## Inputs and outputs
This procedure reads and writes the following around report:
- The report body
- The metric summary
- The distribution list
- The reporting window

## Procedure
1. Finalize report.
2. Promote the metric summary through the reporting pipeline.
3. Confirm the sign-off.
4. Announce availability.

## Verification
Confirm the sign-off is within its expected bound and that the report body reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the reporting pipeline rather than a cached copy.

## Failure modes
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the reporting window from the recovery point identified in the preconditions, reattach report to the distribution channel, and confirm the sign-off returns to baseline. Never leave report in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond report, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `decommission-service`
- `reconfigure-service`
- `rollback-service`

## Notes and edge cases
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.

## Additional considerations
A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The change owner should confirm the metric summary reflects the intended state before treating the step as complete. The change owner should leave a clear note for the next person about what remains and why. The change owner should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point.

A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure is expected to verify the sign-off independently rather than trusting a single reading. The person who signs off the operation should confirm the distribution list reflects the intended state before treating the step as complete. The operator running this procedure should prefer stopping over guessing whenever the reporting pipeline returns an ambiguous response.

A reviewer checking the result afterwards is expected to verify the sign-off independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards is expected to verify the sign-off independently rather than trusting a single reading. The operator running this procedure should prefer stopping over guessing whenever the distribution channel returns an ambiguous response. Anyone continuing this work in a follow-up session should confirm the reporting window reflects the intended state before treating the step as complete.

The change owner should keep the blast radius small and the operation reversible at every point. The on-call responder must not disable a check to make progress, because a failing check is information. The person who signs off the operation needs to confirm that the distribution channel actually accepted the change and now reflects it. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure must not disable a check to make progress, because a failing check is information.

The on-call responder must not disable a check to make progress, because a failing check is information. The change owner must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should confirm the report body reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards should confirm the report body reflects the intended state before treating the step as complete.

An auditor reconstructing the timeline later should confirm the metric summary reflects the intended state before treating the step as complete. The on-call responder must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should prefer stopping over guessing whenever the distribution channel returns an ambiguous response. The operator running this procedure needs to confirm that the datastore actually accepted the change and now reflects it. A reviewer checking the result afterwards should prefer stopping over guessing whenever the reporting pipeline returns an ambiguous response.
