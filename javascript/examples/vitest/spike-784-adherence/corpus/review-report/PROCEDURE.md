---
id: review-report
kind: procedure
keywords: [review, report, operation, procedure, recovery]
links: [escalate-ticket, archive-payment, decommission-queue, validate-payment]
status: active
---
# Review Report

## Purpose
This procedure describes how to evaluate report and record an explicit decision. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a scheduled maintenance window requires it.
- Use this when an alert indicates the target has degraded.
- Use this when a request from an owner has been approved.
- Use this when a dependency change forces a corresponding update here.

## Preconditions
- [ ] No conflicting operation is in progress against the same target.
- [ ] You have the authorization required for this operation.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The change window is open and stakeholders have been informed.
- [ ] The rollback path has been identified and is known to work.

## Inputs and outputs
This procedure reads and writes the following around report:
- The report body
- The metric summary
- The distribution list
- The reporting window

## Procedure
1. Collect report and its context from the distribution channel.
2. Assess it against the reporting window.
3. Record the decision.
4. Confirm the sign-off.

## Verification
Confirm the sign-off is within its expected bound and that the reporting window reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the distribution channel rather than a cached copy.

## Failure modes
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the report body from the recovery point identified in the preconditions, reattach report to the reporting pipeline, and confirm the sign-off returns to baseline. Never leave report in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond report, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `archive-payment`
- `decommission-queue`
- `validate-payment`

## Notes and edge cases
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.

## Additional considerations
The person who signs off the operation should leave a clear note for the next person about what remains and why. The on-call responder is expected to verify the sign-off independently rather than trusting a single reading. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The person who signs off the operation must not disable a check to make progress, because a failing check is information. The change owner must not disable a check to make progress, because a failing check is information.

The person who signs off the operation should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards is expected to verify the sign-off independently rather than trusting a single reading. The change owner needs to confirm that the distribution channel actually accepted the change and now reflects it. A reviewer checking the result afterwards is expected to verify the sign-off independently rather than trusting a single reading. The person who signs off the operation should keep the blast radius small and the operation reversible at every point.

The on-call responder should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The on-call responder is expected to verify the sign-off independently rather than trusting a single reading. The person who signs off the operation should prefer stopping over guessing whenever the datastore returns an ambiguous response. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point.

An auditor reconstructing the timeline later is expected to verify the sign-off independently rather than trusting a single reading. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure is expected to verify the sign-off independently rather than trusting a single reading. The operator running this procedure should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session needs to confirm that the reporting pipeline actually accepted the change and now reflects it.

The operator running this procedure should prefer stopping over guessing whenever the datastore returns an ambiguous response. The operator running this procedure should confirm the metric summary reflects the intended state before treating the step as complete. The on-call responder needs to confirm that the reporting pipeline actually accepted the change and now reflects it. A reviewer checking the result afterwards needs to confirm that the distribution channel actually accepted the change and now reflects it. A reviewer checking the result afterwards needs to confirm that the reporting pipeline actually accepted the change and now reflects it.

The operator running this procedure is expected to verify the sign-off independently rather than trusting a single reading. An auditor reconstructing the timeline later is expected to verify the sign-off independently rather than trusting a single reading. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The change owner needs to confirm that the datastore actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point.
