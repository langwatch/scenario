---
id: snapshot-schema
kind: procedure
keywords: [snapshot, schema, runbook, recovery, safety]
links: [escalate-ticket, validate-cache, provision-queue, validate-refund]
status: active
---
# Snapshot Schema

## Purpose
This procedure describes how to capture a consistent point-in-time copy of schema. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a request from an owner has been approved.
- Use this when a dependency change forces a corresponding update here.
- Use this when a scheduled maintenance window requires it.
- Use this when a preceding procedure explicitly hands off to this one.

## Preconditions
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The change window is open and stakeholders have been informed.
- [ ] The rollback path has been identified and is known to work.
- [ ] No conflicting operation is in progress against the same target.

## Inputs and outputs
This procedure reads and writes the following around schema:
- The migration script
- The column set
- The constraint list
- The version marker

## Procedure
1. Quiesce writes to schema.
2. Capture the version marker.
3. Verify the snapshot against the migration status.
4. Register it in the migration runner.

## Verification
Confirm the migration status is within its expected bound and that the constraint list reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the migration runner rather than a cached copy.

## Failure modes
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the constraint list from the recovery point identified in the preconditions, reattach schema to the datastore, and confirm the migration status returns to baseline. Never leave schema in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond schema, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `validate-cache`
- `provision-queue`
- `validate-refund`

## Notes and edge cases
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.

## Additional considerations
A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The on-call responder is expected to verify the migration status independently rather than trusting a single reading. An auditor reconstructing the timeline later needs to confirm that the compatibility gate actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session needs to confirm that the datastore actually accepted the change and now reflects it. The on-call responder should confirm the constraint list reflects the intended state before treating the step as complete.

Anyone continuing this work in a follow-up session should confirm the column set reflects the intended state before treating the step as complete. The change owner is expected to verify the migration status independently rather than trusting a single reading. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation must not disable a check to make progress, because a failing check is information.

A reviewer checking the result afterwards is expected to verify the migration status independently rather than trusting a single reading. The change owner is expected to verify the migration status independently rather than trusting a single reading. The operator running this procedure should confirm the column set reflects the intended state before treating the step as complete. The person who signs off the operation should confirm the version marker reflects the intended state before treating the step as complete. The on-call responder should confirm the version marker reflects the intended state before treating the step as complete.

Anyone continuing this work in a follow-up session needs to confirm that the migration runner actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards should confirm the version marker reflects the intended state before treating the step as complete. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The on-call responder should leave a clear note for the next person about what remains and why.

A reviewer checking the result afterwards needs to confirm that the migration runner actually accepted the change and now reflects it. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The on-call responder is expected to verify the migration status independently rather than trusting a single reading. The operator running this procedure needs to confirm that the datastore actually accepted the change and now reflects it.

The operator running this procedure should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session is expected to verify the migration status independently rather than trusting a single reading. The change owner is expected to verify the migration status independently rather than trusting a single reading. The person who signs off the operation needs to confirm that the migration runner actually accepted the change and now reflects it. The change owner needs to confirm that the compatibility gate actually accepted the change and now reflects it.
