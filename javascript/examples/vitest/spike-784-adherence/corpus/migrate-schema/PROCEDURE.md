---
id: migrate-schema
kind: procedure
keywords: [migrate, schema, operation, controlled, runbook]
links: [escalate-ticket, decommission-service, drain-service, restore-datastore]
status: active
---
# Migrate Schema

## Purpose
This procedure describes how to move schema to a new format or location without loss. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a periodic policy requires the operation on a cadence.
- Use this when an alert indicates the target has degraded.
- Use this when a dependency change forces a corresponding update here.
- Use this when a scheduled maintenance window requires it.
- Use this when a request from an owner has been approved.

## Preconditions
- [ ] No conflicting operation is in progress against the same target.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The change window is open and stakeholders have been informed.
- [ ] The rollback path has been identified and is known to work.

## Inputs and outputs
This procedure reads and writes the following around schema:
- The migration script
- The column set
- The constraint list
- The version marker

## Procedure
1. Prepare the migration for schema.
2. Apply it to the datastore.
3. Verify the migration status.
4. Reconcile the constraint list.

## Verification
Confirm the migration status is within its expected bound and that the migration script reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the compatibility gate rather than a cached copy.

## Failure modes
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the column set from the recovery point identified in the preconditions, reattach schema to the datastore, and confirm the migration status returns to baseline. Never leave schema in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond schema, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `decommission-service`
- `drain-service`
- `restore-datastore`

## Notes and edge cases
- Tag every artifact you produce with the operation id so it can be correlated later.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Record who performed the operation and when, so the audit ledger stays trustworthy.

## Additional considerations
The change owner should prefer stopping over guessing whenever the compatibility gate returns an ambiguous response. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The operator running this procedure needs to confirm that the compatibility gate actually accepted the change and now reflects it. The on-call responder should prefer stopping over guessing whenever the migration runner returns an ambiguous response.

The person who signs off the operation should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The operator running this procedure needs to confirm that the datastore actually accepted the change and now reflects it. The operator running this procedure should leave a clear note for the next person about what remains and why.

The person who signs off the operation should leave a clear note for the next person about what remains and why. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later needs to confirm that the migration runner actually accepted the change and now reflects it. The change owner should leave a clear note for the next person about what remains and why.

The person who signs off the operation must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later is expected to verify the migration status independently rather than trusting a single reading. The person who signs off the operation is expected to verify the migration status independently rather than trusting a single reading. The person who signs off the operation must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point.

A reviewer checking the result afterwards is expected to verify the migration status independently rather than trusting a single reading. The change owner must record what was observed against the operation id so the history stays reconstructable. The on-call responder must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session is expected to verify the migration status independently rather than trusting a single reading.

A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the migration runner returns an ambiguous response. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the migration runner returns an ambiguous response. The change owner should confirm the column set reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should confirm the version marker reflects the intended state before treating the step as complete.
