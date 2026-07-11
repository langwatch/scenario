---
id: rollback-schema
kind: procedure
keywords: [rollback, schema, operation, audited, safety]
links: [escalate-ticket, provision-cluster, snapshot-cache, archive-release]
status: active
---
# Roll Back Schema

## Purpose
This procedure describes how to revert schema to the last known-good state after a failed change. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a scheduled maintenance window requires it.
- Use this when a request from an owner has been approved.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when an alert indicates the target has degraded.
- Use this when a dependency change forces a corresponding update here.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] You have the authorization required for this operation.

## Inputs and outputs
This procedure reads and writes the following around schema:
- The migration script
- The column set
- The constraint list
- The version marker

## Procedure
1. Identify the last known-good version of schema.
2. Halt further promotion.
3. Restore the version marker.
4. Confirm the migration status returns to baseline.

## Verification
Confirm the migration status is within its expected bound and that the version marker reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the datastore rather than a cached copy.

## Failure modes
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the migration script from the recovery point identified in the preconditions, reattach schema to the datastore, and confirm the migration status returns to baseline. Never leave schema in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond schema, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `provision-cluster`
- `snapshot-cache`
- `archive-release`

## Notes and edge cases
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.

## Additional considerations
An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later is expected to verify the migration status independently rather than trusting a single reading. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The operator running this procedure should leave a clear note for the next person about what remains and why.

The operator running this procedure is expected to verify the migration status independently rather than trusting a single reading. The on-call responder should keep the blast radius small and the operation reversible at every point. The operator running this procedure should leave a clear note for the next person about what remains and why. The operator running this procedure should keep the blast radius small and the operation reversible at every point. The change owner should prefer stopping over guessing whenever the datastore returns an ambiguous response.

An auditor reconstructing the timeline later is expected to verify the migration status independently rather than trusting a single reading. The operator running this procedure should confirm the constraint list reflects the intended state before treating the step as complete. The on-call responder should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards should confirm the constraint list reflects the intended state before treating the step as complete. The on-call responder should leave a clear note for the next person about what remains and why.

The on-call responder should leave a clear note for the next person about what remains and why. The change owner should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later is expected to verify the migration status independently rather than trusting a single reading. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the datastore returns an ambiguous response. The on-call responder must not disable a check to make progress, because a failing check is information.

An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session is expected to verify the migration status independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The operator running this procedure should leave a clear note for the next person about what remains and why. The change owner should prefer stopping over guessing whenever the compatibility gate returns an ambiguous response.

An auditor reconstructing the timeline later should prefer stopping over guessing whenever the datastore returns an ambiguous response. The change owner needs to confirm that the compatibility gate actually accepted the change and now reflects it. The change owner needs to confirm that the migration runner actually accepted the change and now reflects it. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The on-call responder should prefer stopping over guessing whenever the datastore returns an ambiguous response.
