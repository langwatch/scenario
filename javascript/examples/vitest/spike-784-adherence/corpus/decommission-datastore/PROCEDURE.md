---
id: decommission-datastore
kind: procedure
keywords: [decommission, datastore, reversible, recovery, controlled]
links: [escalate-ticket, snapshot-cache, reconcile-policy, quarantine-file]
status: active
---
# Decommission Datastore

## Purpose
This procedure describes how to retire datastore and reclaim its resources cleanly. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when an alert indicates the target has degraded.
- Use this when a scheduled maintenance window requires it.
- Use this when a request from an owner has been approved.
- Use this when a dependency change forces a corresponding update here.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] You have the authorization required for this operation.
- [ ] The change window is open and stakeholders have been informed.
- [ ] The rollback path has been identified and is known to work.
- [ ] The relevant dashboards and alerts are visible to you for the duration.

## Inputs and outputs
This procedure reads and writes the following around datastore:
- The snapshot
- The replication lag
- The schema
- The backup catalog

## Procedure
1. Confirm datastore carries no live traffic.
2. Detach datastore from the backup vault.
3. Archive the schema.
4. Record the retirement.

## Verification
Confirm the consistency check is within its expected bound and that the schema reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the primary rather than a cached copy.

## Failure modes
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the snapshot from the recovery point identified in the preconditions, reattach datastore to the backup vault, and confirm the consistency check returns to baseline. Never leave datastore in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond datastore, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `snapshot-cache`
- `reconcile-policy`
- `quarantine-file`

## Notes and edge cases
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- A dry run against a non-production copy is cheap insurance for any irreversible step.

## Additional considerations
An auditor reconstructing the timeline later needs to confirm that the replica set actually accepted the change and now reflects it. An auditor reconstructing the timeline later should confirm the snapshot reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session needs to confirm that the backup vault actually accepted the change and now reflects it. The person who signs off the operation must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why.

The change owner must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the replica set returns an ambiguous response. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session should confirm the replication lag reflects the intended state before treating the step as complete.

The operator running this procedure should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later needs to confirm that the replica set actually accepted the change and now reflects it. The operator running this procedure needs to confirm that the backup vault actually accepted the change and now reflects it. The person who signs off the operation must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the backup vault returns an ambiguous response.

The person who signs off the operation should leave a clear note for the next person about what remains and why. The on-call responder is expected to verify the consistency check independently rather than trusting a single reading. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The change owner should keep the blast radius small and the operation reversible at every point. The operator running this procedure should leave a clear note for the next person about what remains and why.

The operator running this procedure should prefer stopping over guessing whenever the replica set returns an ambiguous response. The on-call responder must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards needs to confirm that the backup vault actually accepted the change and now reflects it. A reviewer checking the result afterwards should prefer stopping over guessing whenever the primary returns an ambiguous response.

The operator running this procedure must not disable a check to make progress, because a failing check is information. The operator running this procedure must not disable a check to make progress, because a failing check is information. The operator running this procedure should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the primary returns an ambiguous response. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why.
