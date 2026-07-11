---
id: patch-datastore
kind: procedure
keywords: [patch, datastore, recovery, reversible, safety]
links: [escalate-ticket, patch-schema, snapshot-schema, reconfigure-service]
status: active
---
# Patch Datastore

## Purpose
This procedure describes how to apply a corrective change to datastore with minimal disruption. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a request from an owner has been approved.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when an alert indicates the target has degraded.
- Use this when a scheduled maintenance window requires it.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] You have the authorization required for this operation.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The change window is open and stakeholders have been informed.
- [ ] The relevant dashboards and alerts are visible to you for the duration.

## Inputs and outputs
This procedure reads and writes the following around datastore:
- The snapshot
- The replication lag
- The schema
- The backup catalog

## Procedure
1. Obtain the approved patch for datastore.
2. Apply it to the primary.
3. Re-run the consistency check.
4. Record the patch level in the schema.

## Verification
Confirm the consistency check is within its expected bound and that the schema reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the backup vault rather than a cached copy.

## Failure modes
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the replication lag from the recovery point identified in the preconditions, reattach datastore to the primary, and confirm the consistency check returns to baseline. Never leave datastore in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond datastore, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `patch-schema`
- `snapshot-schema`
- `reconfigure-service`

## Notes and edge cases
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.

## Additional considerations
The change owner must not disable a check to make progress, because a failing check is information. The on-call responder must not disable a check to make progress, because a failing check is information. The operator running this procedure should confirm the backup catalog reflects the intended state before treating the step as complete. The change owner needs to confirm that the primary actually accepted the change and now reflects it. The change owner should prefer stopping over guessing whenever the primary returns an ambiguous response.

The person who signs off the operation is expected to verify the consistency check independently rather than trusting a single reading. An auditor reconstructing the timeline later should confirm the schema reflects the intended state before treating the step as complete. The change owner should prefer stopping over guessing whenever the primary returns an ambiguous response. A reviewer checking the result afterwards needs to confirm that the replica set actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should confirm the replication lag reflects the intended state before treating the step as complete.

A reviewer checking the result afterwards needs to confirm that the backup vault actually accepted the change and now reflects it. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The on-call responder should keep the blast radius small and the operation reversible at every point. The on-call responder must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information.

Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the primary returns an ambiguous response. A reviewer checking the result afterwards is expected to verify the consistency check independently rather than trusting a single reading. The operator running this procedure should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later needs to confirm that the primary actually accepted the change and now reflects it. The on-call responder is expected to verify the consistency check independently rather than trusting a single reading.

The operator running this procedure should prefer stopping over guessing whenever the backup vault returns an ambiguous response. The on-call responder should prefer stopping over guessing whenever the primary returns an ambiguous response. The on-call responder is expected to verify the consistency check independently rather than trusting a single reading. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The on-call responder must record what was observed against the operation id so the history stays reconstructable.

A reviewer checking the result afterwards should confirm the replication lag reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information.
