---
id: reconfigure-datastore
kind: procedure
keywords: [reconfigure, datastore, controlled, operation, audited]
links: [escalate-ticket, publish-release, review-report, publish-report]
status: active
---
# Reconfigure Datastore

## Purpose
This procedure describes how to change the configuration of datastore in a controlled way. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a dependency change forces a corresponding update here.
- Use this when an alert indicates the target has degraded.
- Use this when a request from an owner has been approved.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] The change window is open and stakeholders have been informed.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] No conflicting operation is in progress against the same target.
- [ ] You have the authorization required for this operation.

## Inputs and outputs
This procedure reads and writes the following around datastore:
- The snapshot
- The replication lag
- The schema
- The backup catalog

## Procedure
1. Capture the current configuration of datastore.
2. Apply the new settings to the replica set.
3. Validate against the consistency check.
4. Persist the replication lag.

## Verification
Confirm the consistency check is within its expected bound and that the replication lag reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the backup vault rather than a cached copy.

## Failure modes
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the replication lag from the recovery point identified in the preconditions, reattach datastore to the backup vault, and confirm the consistency check returns to baseline. Never leave datastore in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond datastore, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `publish-release`
- `review-report`
- `publish-report`

## Notes and edge cases
- Tag every artifact you produce with the operation id so it can be correlated later.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- A dry run against a non-production copy is cheap insurance for any irreversible step.

## Additional considerations
A reviewer checking the result afterwards needs to confirm that the primary actually accepted the change and now reflects it. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The on-call responder must not disable a check to make progress, because a failing check is information. The on-call responder should prefer stopping over guessing whenever the backup vault returns an ambiguous response. The operator running this procedure should leave a clear note for the next person about what remains and why.

A reviewer checking the result afterwards is expected to verify the consistency check independently rather than trusting a single reading. A reviewer checking the result afterwards needs to confirm that the replica set actually accepted the change and now reflects it. The on-call responder is expected to verify the consistency check independently rather than trusting a single reading. An auditor reconstructing the timeline later is expected to verify the consistency check independently rather than trusting a single reading. An auditor reconstructing the timeline later needs to confirm that the replica set actually accepted the change and now reflects it.

The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later needs to confirm that the backup vault actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should prefer stopping over guessing whenever the replica set returns an ambiguous response. The change owner must not disable a check to make progress, because a failing check is information.

The operator running this procedure must not disable a check to make progress, because a failing check is information. The person who signs off the operation needs to confirm that the backup vault actually accepted the change and now reflects it. The person who signs off the operation is expected to verify the consistency check independently rather than trusting a single reading. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The person who signs off the operation should keep the blast radius small and the operation reversible at every point.

The change owner should confirm the snapshot reflects the intended state before treating the step as complete. The person who signs off the operation should prefer stopping over guessing whenever the primary returns an ambiguous response. The operator running this procedure must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later is expected to verify the consistency check independently rather than trusting a single reading. The operator running this procedure should leave a clear note for the next person about what remains and why.

The change owner should confirm the replication lag reflects the intended state before treating the step as complete. The person who signs off the operation should confirm the replication lag reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should prefer stopping over guessing whenever the replica set returns an ambiguous response. The operator running this procedure should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later needs to confirm that the primary actually accepted the change and now reflects it.
