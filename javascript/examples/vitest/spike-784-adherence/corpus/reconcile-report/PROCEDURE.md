---
id: reconcile-report
kind: procedure
keywords: [reconcile, report, reversible, procedure, controlled]
links: [escalate-ticket, archive-invoice, scale-service, archive-dataset]
status: active
---
# Reconcile Report

## Purpose
This procedure describes how to bring report into agreement with the source of truth. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when an alert indicates the target has degraded.
- Use this when a dependency change forces a corresponding update here.
- Use this when a request from an owner has been approved.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] No conflicting operation is in progress against the same target.
- [ ] You have the authorization required for this operation.

## Inputs and outputs
This procedure reads and writes the following around report:
- The report body
- The metric summary
- The distribution list
- The reporting window

## Procedure
1. Gather report from the distribution channel.
2. Compare against the distribution list.
3. Resolve each discrepancy.
4. Confirm the sign-off.

## Verification
Confirm the sign-off is within its expected bound and that the metric summary reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the reporting pipeline rather than a cached copy.

## Failure modes
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the metric summary from the recovery point identified in the preconditions, reattach report to the distribution channel, and confirm the sign-off returns to baseline. Never leave report in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond report, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `archive-invoice`
- `scale-service`
- `archive-dataset`

## Notes and edge cases
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Record who performed the operation and when, so the audit ledger stays trustworthy.

## Additional considerations
The person who signs off the operation should confirm the reporting window reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should confirm the report body reflects the intended state before treating the step as complete. The operator running this procedure needs to confirm that the distribution channel actually accepted the change and now reflects it. The person who signs off the operation is expected to verify the sign-off independently rather than trusting a single reading. The operator running this procedure should confirm the distribution list reflects the intended state before treating the step as complete.

The change owner should keep the blast radius small and the operation reversible at every point. The on-call responder should prefer stopping over guessing whenever the distribution channel returns an ambiguous response. The operator running this procedure must not disable a check to make progress, because a failing check is information. The on-call responder needs to confirm that the datastore actually accepted the change and now reflects it. The on-call responder should confirm the reporting window reflects the intended state before treating the step as complete.

The person who signs off the operation should keep the blast radius small and the operation reversible at every point. The person who signs off the operation needs to confirm that the datastore actually accepted the change and now reflects it. The change owner should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session is expected to verify the sign-off independently rather than trusting a single reading. The on-call responder should confirm the reporting window reflects the intended state before treating the step as complete.

Anyone continuing this work in a follow-up session is expected to verify the sign-off independently rather than trusting a single reading. The on-call responder should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session needs to confirm that the reporting pipeline actually accepted the change and now reflects it. The operator running this procedure should confirm the metric summary reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the reporting pipeline returns an ambiguous response.

The change owner should confirm the reporting window reflects the intended state before treating the step as complete. The operator running this procedure should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should confirm the reporting window reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The operator running this procedure needs to confirm that the reporting pipeline actually accepted the change and now reflects it.

The person who signs off the operation should keep the blast radius small and the operation reversible at every point. The change owner should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should confirm the metric summary reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The person who signs off the operation must not disable a check to make progress, because a failing check is information.
