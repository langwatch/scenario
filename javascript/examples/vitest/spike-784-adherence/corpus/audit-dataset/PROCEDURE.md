---
id: audit-dataset
kind: procedure
keywords: [audit, dataset, safety, operation, recovery]
links: [escalate-ticket, audit-invoice, drain-queue, audit-gateway]
status: active
---
# Audit Dataset

## Purpose
This procedure describes how to review dataset against policy and record findings. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a periodic policy requires the operation on a cadence.
- Use this when an alert indicates the target has degraded.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a scheduled maintenance window requires it.
- Use this when a dependency change forces a corresponding update here.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] The change window is open and stakeholders have been informed.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] You have the authorization required for this operation.

## Inputs and outputs
This procedure reads and writes the following around dataset:
- The dataset snapshot
- The schema descriptor
- The row count
- The lineage record

## Procedure
1. Enumerate dataset in the datastore.
2. Compare each against policy.
3. Record deviations in the lineage record.
4. Confirm the freshness marker.

## Verification
Confirm the freshness marker is within its expected bound and that the lineage record reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the catalog rather than a cached copy.

## Failure modes
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the row count from the recovery point identified in the preconditions, reattach dataset to the pipeline, and confirm the freshness marker returns to baseline. Never leave dataset in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond dataset, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `audit-invoice`
- `drain-queue`
- `audit-gateway`

## Notes and edge cases
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.

## Additional considerations
Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation is expected to verify the freshness marker independently rather than trusting a single reading. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The change owner should leave a clear note for the next person about what remains and why.

An auditor reconstructing the timeline later needs to confirm that the catalog actually accepted the change and now reflects it. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The on-call responder should confirm the lineage record reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the catalog returns an ambiguous response. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information.

An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The change owner should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards is expected to verify the freshness marker independently rather than trusting a single reading. The operator running this procedure needs to confirm that the datastore actually accepted the change and now reflects it.

The on-call responder must not disable a check to make progress, because a failing check is information. The person who signs off the operation should confirm the lineage record reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the catalog returns an ambiguous response. The on-call responder must record what was observed against the operation id so the history stays reconstructable. The on-call responder must not disable a check to make progress, because a failing check is information.

An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The change owner must not disable a check to make progress, because a failing check is information. The on-call responder should prefer stopping over guessing whenever the catalog returns an ambiguous response. The operator running this procedure should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information.

The person who signs off the operation should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure should prefer stopping over guessing whenever the catalog returns an ambiguous response. The on-call responder should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable.
