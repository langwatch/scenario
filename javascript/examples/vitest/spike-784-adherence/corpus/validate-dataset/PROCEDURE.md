---
id: validate-dataset
kind: procedure
keywords: [validate, dataset, procedure, audited, safety]
links: [escalate-ticket, patch-endpoint, reconcile-ticket, review-vendor]
status: active
---
# Validate Dataset

## Purpose
This procedure describes how to check that dataset meets its correctness criteria. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a dependency change forces a corresponding update here.
- Use this when a request from an owner has been approved.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a scheduled maintenance window requires it.

## Preconditions
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] You have the authorization required for this operation.
- [ ] The rollback path has been identified and is known to work.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] No conflicting operation is in progress against the same target.

## Inputs and outputs
This procedure reads and writes the following around dataset:
- The dataset snapshot
- The schema descriptor
- The row count
- The lineage record

## Procedure
1. Load dataset from the pipeline.
2. Run the checks against the row count.
3. Confirm the freshness marker.
4. Record the outcome.

## Verification
Confirm the freshness marker is within its expected bound and that the schema descriptor reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the pipeline rather than a cached copy.

## Failure modes
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the row count from the recovery point identified in the preconditions, reattach dataset to the pipeline, and confirm the freshness marker returns to baseline. Never leave dataset in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond dataset, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `patch-endpoint`
- `reconcile-ticket`
- `review-vendor`

## Notes and edge cases
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Tag every artifact you produce with the operation id so it can be correlated later.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.

## Additional considerations
An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session needs to confirm that the datastore actually accepted the change and now reflects it. The on-call responder should keep the blast radius small and the operation reversible at every point. The on-call responder must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information.

An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The change owner is expected to verify the freshness marker independently rather than trusting a single reading. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards should prefer stopping over guessing whenever the catalog returns an ambiguous response.

The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards needs to confirm that the pipeline actually accepted the change and now reflects it. The on-call responder must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should prefer stopping over guessing whenever the datastore returns an ambiguous response. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable.

Anyone continuing this work in a follow-up session should confirm the schema descriptor reflects the intended state before treating the step as complete. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later is expected to verify the freshness marker independently rather than trusting a single reading. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The on-call responder should confirm the row count reflects the intended state before treating the step as complete.

The on-call responder should confirm the row count reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session should confirm the row count reflects the intended state before treating the step as complete. The on-call responder should keep the blast radius small and the operation reversible at every point. The change owner should leave a clear note for the next person about what remains and why.

The person who signs off the operation should prefer stopping over guessing whenever the catalog returns an ambiguous response. The person who signs off the operation should prefer stopping over guessing whenever the pipeline returns an ambiguous response. The change owner should confirm the schema descriptor reflects the intended state before treating the step as complete. A reviewer checking the result afterwards is expected to verify the freshness marker independently rather than trusting a single reading. A reviewer checking the result afterwards should prefer stopping over guessing whenever the catalog returns an ambiguous response.
