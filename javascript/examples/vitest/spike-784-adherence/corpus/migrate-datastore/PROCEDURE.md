---
id: migrate-datastore
kind: procedure
keywords: [migrate, datastore, runbook, procedure, operation]
links: [escalate-ticket, audit-refund, validate-policy, validate-release]
status: active
---
# Migrate Datastore

## Purpose
This procedure describes how to move datastore to a new format or location without loss. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when an alert indicates the target has degraded.
- Use this when a scheduled maintenance window requires it.
- Use this when a request from an owner has been approved.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a dependency change forces a corresponding update here.

## Preconditions
- [ ] No conflicting operation is in progress against the same target.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] You have the authorization required for this operation.
- [ ] The change window is open and stakeholders have been informed.

## Inputs and outputs
This procedure reads and writes the following around datastore:
- The snapshot
- The replication lag
- The schema
- The backup catalog

## Procedure
1. Prepare the migration for datastore.
2. Apply it to the primary.
3. Verify the consistency check.
4. Reconcile the backup catalog.

## Verification
Confirm the consistency check is within its expected bound and that the replication lag reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the primary rather than a cached copy.

## Failure modes
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the schema from the recovery point identified in the preconditions, reattach datastore to the primary, and confirm the consistency check returns to baseline. Never leave datastore in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond datastore, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `audit-refund`
- `validate-policy`
- `validate-release`

## Notes and edge cases
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.

## Additional considerations
Anyone continuing this work in a follow-up session should confirm the backup catalog reflects the intended state before treating the step as complete. The change owner should prefer stopping over guessing whenever the primary returns an ambiguous response. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure should prefer stopping over guessing whenever the replica set returns an ambiguous response. Anyone continuing this work in a follow-up session is expected to verify the consistency check independently rather than trusting a single reading.

Anyone continuing this work in a follow-up session is expected to verify the consistency check independently rather than trusting a single reading. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards needs to confirm that the replica set actually accepted the change and now reflects it. The change owner should confirm the snapshot reflects the intended state before treating the step as complete. The operator running this procedure should prefer stopping over guessing whenever the primary returns an ambiguous response.

Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the replica set returns an ambiguous response. The person who signs off the operation needs to confirm that the primary actually accepted the change and now reflects it. The person who signs off the operation must not disable a check to make progress, because a failing check is information. The operator running this procedure needs to confirm that the backup vault actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why.

The on-call responder must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The change owner must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should confirm the replication lag reflects the intended state before treating the step as complete.

The operator running this procedure should confirm the snapshot reflects the intended state before treating the step as complete. The on-call responder must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards needs to confirm that the primary actually accepted the change and now reflects it. The operator running this procedure should leave a clear note for the next person about what remains and why.

The on-call responder must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure must not disable a check to make progress, because a failing check is information. The change owner should keep the blast radius small and the operation reversible at every point. The change owner must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable.
