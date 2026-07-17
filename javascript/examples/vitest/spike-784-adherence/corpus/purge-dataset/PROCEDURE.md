---
id: purge-dataset
kind: procedure
keywords: [purge, dataset, runbook, procedure, safety]
links: [escalate-ticket, replicate-datastore, restart-service, reconfigure-datastore]
status: active
---
# Purge Dataset

## Purpose
This procedure describes how to permanently remove dataset once it is no longer needed. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a scheduled maintenance window requires it.
- Use this when a request from an owner has been approved.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when an alert indicates the target has degraded.

## Preconditions
- [ ] The change window is open and stakeholders have been informed.
- [ ] You have the authorization required for this operation.
- [ ] The rollback path has been identified and is known to work.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The relevant dashboards and alerts are visible to you for the duration.

## Inputs and outputs
This procedure reads and writes the following around dataset:
- The dataset snapshot
- The schema descriptor
- The row count
- The lineage record

## Procedure
1. Confirm dataset is past its retention.
2. Remove it from the datastore.
3. Confirm the freshness marker.
4. Record the deletion in the dataset snapshot.

## Verification
Confirm the freshness marker is within its expected bound and that the dataset snapshot reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the datastore rather than a cached copy.

## Failure modes
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the lineage record from the recovery point identified in the preconditions, reattach dataset to the catalog, and confirm the freshness marker returns to baseline. Never leave dataset in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond dataset, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `replicate-datastore`
- `restart-service`
- `reconfigure-datastore`

## Notes and edge cases
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.

## Additional considerations
The operator running this procedure should leave a clear note for the next person about what remains and why. The operator running this procedure should keep the blast radius small and the operation reversible at every point. The on-call responder needs to confirm that the catalog actually accepted the change and now reflects it. A reviewer checking the result afterwards should prefer stopping over guessing whenever the pipeline returns an ambiguous response. Anyone continuing this work in a follow-up session needs to confirm that the datastore actually accepted the change and now reflects it.

The on-call responder is expected to verify the freshness marker independently rather than trusting a single reading. The person who signs off the operation is expected to verify the freshness marker independently rather than trusting a single reading. The on-call responder should prefer stopping over guessing whenever the catalog returns an ambiguous response. The on-call responder should confirm the row count reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later is expected to verify the freshness marker independently rather than trusting a single reading.

The change owner should confirm the schema descriptor reflects the intended state before treating the step as complete. The change owner should prefer stopping over guessing whenever the pipeline returns an ambiguous response. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the catalog returns an ambiguous response. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the catalog returns an ambiguous response.

Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The person who signs off the operation is expected to verify the freshness marker independently rather than trusting a single reading. The on-call responder should confirm the lineage record reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later needs to confirm that the pipeline actually accepted the change and now reflects it. The person who signs off the operation should keep the blast radius small and the operation reversible at every point.

Anyone continuing this work in a follow-up session needs to confirm that the pipeline actually accepted the change and now reflects it. The person who signs off the operation should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The change owner should prefer stopping over guessing whenever the catalog returns an ambiguous response.

Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. The on-call responder must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation needs to confirm that the pipeline actually accepted the change and now reflects it. The on-call responder should confirm the lineage record reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why.
