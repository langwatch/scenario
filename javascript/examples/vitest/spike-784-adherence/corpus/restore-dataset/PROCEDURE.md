---
id: restore-dataset
kind: procedure
keywords: [restore, dataset, runbook, safety, recovery]
links: [escalate-ticket, archive-policy, deploy-service, revoke-certificate]
status: active
---
# Restore Dataset

## Purpose
This procedure describes how to recover dataset from a known-good copy. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a dependency change forces a corresponding update here.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a request from an owner has been approved.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when an alert indicates the target has degraded.

## Preconditions
- [ ] The change window is open and stakeholders have been informed.
- [ ] The rollback path has been identified and is known to work.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] You have the authorization required for this operation.

## Inputs and outputs
This procedure reads and writes the following around dataset:
- The dataset snapshot
- The schema descriptor
- The row count
- The lineage record

## Procedure
1. Select the recovery point for dataset.
2. Restore the dataset snapshot into the datastore.
3. Verify the freshness marker.
4. Reconcile any gap.

## Verification
Confirm the freshness marker is within its expected bound and that the lineage record reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the pipeline rather than a cached copy.

## Failure modes
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the row count from the recovery point identified in the preconditions, reattach dataset to the catalog, and confirm the freshness marker returns to baseline. Never leave dataset in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond dataset, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `archive-policy`
- `deploy-service`
- `revoke-certificate`

## Notes and edge cases
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.

## Additional considerations
A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later is expected to verify the freshness marker independently rather than trusting a single reading. The person who signs off the operation is expected to verify the freshness marker independently rather than trusting a single reading.

The change owner should prefer stopping over guessing whenever the pipeline returns an ambiguous response. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The change owner must record what was observed against the operation id so the history stays reconstructable. The change owner should confirm the lineage record reflects the intended state before treating the step as complete. The operator running this procedure needs to confirm that the catalog actually accepted the change and now reflects it.

A reviewer checking the result afterwards should confirm the row count reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later is expected to verify the freshness marker independently rather than trusting a single reading. The on-call responder is expected to verify the freshness marker independently rather than trusting a single reading. The on-call responder needs to confirm that the datastore actually accepted the change and now reflects it. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information.

The change owner must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The on-call responder should prefer stopping over guessing whenever the datastore returns an ambiguous response. The on-call responder needs to confirm that the datastore actually accepted the change and now reflects it. An auditor reconstructing the timeline later needs to confirm that the catalog actually accepted the change and now reflects it.

The person who signs off the operation should confirm the schema descriptor reflects the intended state before treating the step as complete. The operator running this procedure must not disable a check to make progress, because a failing check is information. The person who signs off the operation should leave a clear note for the next person about what remains and why. The on-call responder should keep the blast radius small and the operation reversible at every point. The operator running this procedure should confirm the row count reflects the intended state before treating the step as complete.

The on-call responder should keep the blast radius small and the operation reversible at every point. The change owner must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The person who signs off the operation should prefer stopping over guessing whenever the pipeline returns an ambiguous response. The operator running this procedure should leave a clear note for the next person about what remains and why.
