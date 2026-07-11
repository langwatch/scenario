---
id: validate-report
kind: procedure
keywords: [validate, report, operation, recovery, audited]
links: [escalate-ticket, audit-dataset, audit-gateway, provision-queue]
status: active
---
# Validate Report

## Purpose
This procedure describes how to check that report meets its correctness criteria. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when an alert indicates the target has degraded.
- Use this when a dependency change forces a corresponding update here.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a request from an owner has been approved.
- Use this when a preceding procedure explicitly hands off to this one.

## Preconditions
- [ ] The change window is open and stakeholders have been informed.
- [ ] The rollback path has been identified and is known to work.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] You have the authorization required for this operation.
- [ ] No conflicting operation is in progress against the same target.

## Inputs and outputs
This procedure reads and writes the following around report:
- The report body
- The metric summary
- The distribution list
- The reporting window

## Procedure
1. Load report from the reporting pipeline.
2. Run the checks against the report body.
3. Confirm the sign-off.
4. Record the outcome.

## Verification
Confirm the sign-off is within its expected bound and that the report body reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the datastore rather than a cached copy.

## Failure modes
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the metric summary from the recovery point identified in the preconditions, reattach report to the distribution channel, and confirm the sign-off returns to baseline. Never leave report in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond report, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `audit-dataset`
- `audit-gateway`
- `provision-queue`

## Notes and edge cases
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Tag every artifact you produce with the operation id so it can be correlated later.
- A dry run against a non-production copy is cheap insurance for any irreversible step.

## Additional considerations
The change owner must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The on-call responder should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The on-call responder should leave a clear note for the next person about what remains and why.

The operator running this procedure should prefer stopping over guessing whenever the distribution channel returns an ambiguous response. The person who signs off the operation is expected to verify the sign-off independently rather than trusting a single reading. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The on-call responder must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation needs to confirm that the distribution channel actually accepted the change and now reflects it.

The operator running this procedure should confirm the report body reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the datastore returns an ambiguous response. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why.

The on-call responder needs to confirm that the reporting pipeline actually accepted the change and now reflects it. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The on-call responder should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The change owner should leave a clear note for the next person about what remains and why.

An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The change owner should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should confirm the metric summary reflects the intended state before treating the step as complete. The on-call responder must record what was observed against the operation id so the history stays reconstructable.

The operator running this procedure should prefer stopping over guessing whenever the distribution channel returns an ambiguous response. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The operator running this procedure is expected to verify the sign-off independently rather than trusting a single reading. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why.
