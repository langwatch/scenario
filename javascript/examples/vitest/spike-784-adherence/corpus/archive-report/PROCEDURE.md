---
id: archive-report
kind: procedure
keywords: [archive, report, controlled, runbook, safety]
links: [escalate-ticket, revoke-access, audit-credential, snapshot-queue]
status: active
---
# Archive Report

## Purpose
This procedure describes how to move report to long-term storage under its retention rules. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when an alert indicates the target has degraded.
- Use this when a request from an owner has been approved.
- Use this when a scheduled maintenance window requires it.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] No conflicting operation is in progress against the same target.
- [ ] You have the authorization required for this operation.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The rollback path has been identified and is known to work.
- [ ] A recent backup or recovery point exists and has been verified as restorable.

## Inputs and outputs
This procedure reads and writes the following around report:
- The report body
- The metric summary
- The distribution list
- The reporting window

## Procedure
1. Confirm report is eligible for archival.
2. Move the distribution list to the datastore.
3. Verify the sign-off.
4. Update the index.

## Verification
Confirm the sign-off is within its expected bound and that the distribution list reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the reporting pipeline rather than a cached copy.

## Failure modes
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the reporting window from the recovery point identified in the preconditions, reattach report to the reporting pipeline, and confirm the sign-off returns to baseline. Never leave report in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond report, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `revoke-access`
- `audit-credential`
- `snapshot-queue`

## Notes and edge cases
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Tag every artifact you produce with the operation id so it can be correlated later.

## Additional considerations
The operator running this procedure needs to confirm that the reporting pipeline actually accepted the change and now reflects it. A reviewer checking the result afterwards needs to confirm that the reporting pipeline actually accepted the change and now reflects it. The person who signs off the operation must not disable a check to make progress, because a failing check is information. The change owner must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should confirm the reporting window reflects the intended state before treating the step as complete.

An auditor reconstructing the timeline later is expected to verify the sign-off independently rather than trusting a single reading. The on-call responder should confirm the distribution list reflects the intended state before treating the step as complete. The on-call responder must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The person who signs off the operation should keep the blast radius small and the operation reversible at every point.

The person who signs off the operation needs to confirm that the datastore actually accepted the change and now reflects it. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The operator running this procedure needs to confirm that the distribution channel actually accepted the change and now reflects it. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The on-call responder needs to confirm that the distribution channel actually accepted the change and now reflects it.

Anyone continuing this work in a follow-up session is expected to verify the sign-off independently rather than trusting a single reading. An auditor reconstructing the timeline later is expected to verify the sign-off independently rather than trusting a single reading. The on-call responder must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The on-call responder must not disable a check to make progress, because a failing check is information.

The person who signs off the operation should keep the blast radius small and the operation reversible at every point. The operator running this procedure should keep the blast radius small and the operation reversible at every point. The change owner should prefer stopping over guessing whenever the distribution channel returns an ambiguous response. The on-call responder should prefer stopping over guessing whenever the datastore returns an ambiguous response. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the distribution channel returns an ambiguous response.

Anyone continuing this work in a follow-up session needs to confirm that the distribution channel actually accepted the change and now reflects it. The change owner should confirm the distribution list reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the datastore returns an ambiguous response. The change owner needs to confirm that the distribution channel actually accepted the change and now reflects it. The operator running this procedure needs to confirm that the reporting pipeline actually accepted the change and now reflects it.
