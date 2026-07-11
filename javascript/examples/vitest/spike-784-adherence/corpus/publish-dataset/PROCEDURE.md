---
id: publish-dataset
kind: procedure
keywords: [publish, dataset, safety, reversible, runbook]
links: [escalate-ticket, review-ticket, validate-cache, validate-file]
status: active
---
# Publish Dataset

## Purpose
This procedure describes how to make dataset available to its consumers under change control. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a request from an owner has been approved.
- Use this when a dependency change forces a corresponding update here.
- Use this when an alert indicates the target has degraded.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] The change window is open and stakeholders have been informed.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The rollback path has been identified and is known to work.

## Inputs and outputs
This procedure reads and writes the following around dataset:
- The dataset snapshot
- The schema descriptor
- The row count
- The lineage record

## Procedure
1. Finalize dataset.
2. Promote the dataset snapshot through the pipeline.
3. Confirm the freshness marker.
4. Announce availability.

## Verification
Confirm the freshness marker is within its expected bound and that the dataset snapshot reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the pipeline rather than a cached copy.

## Failure modes
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the dataset snapshot from the recovery point identified in the preconditions, reattach dataset to the catalog, and confirm the freshness marker returns to baseline. Never leave dataset in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond dataset, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `review-ticket`
- `validate-cache`
- `validate-file`

## Notes and edge cases
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Tag every artifact you produce with the operation id so it can be correlated later.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.

## Additional considerations
Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The on-call responder should prefer stopping over guessing whenever the pipeline returns an ambiguous response. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable.

An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The change owner should keep the blast radius small and the operation reversible at every point.

An auditor reconstructing the timeline later should prefer stopping over guessing whenever the catalog returns an ambiguous response. The person who signs off the operation needs to confirm that the datastore actually accepted the change and now reflects it. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session needs to confirm that the catalog actually accepted the change and now reflects it. The change owner should prefer stopping over guessing whenever the datastore returns an ambiguous response.

A reviewer checking the result afterwards is expected to verify the freshness marker independently rather than trusting a single reading. The operator running this procedure needs to confirm that the pipeline actually accepted the change and now reflects it. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should confirm the lineage record reflects the intended state before treating the step as complete. The operator running this procedure should keep the blast radius small and the operation reversible at every point.

An auditor reconstructing the timeline later needs to confirm that the catalog actually accepted the change and now reflects it. An auditor reconstructing the timeline later should confirm the row count reflects the intended state before treating the step as complete. A reviewer checking the result afterwards is expected to verify the freshness marker independently rather than trusting a single reading. The person who signs off the operation should confirm the schema descriptor reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why.

An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation must not disable a check to make progress, because a failing check is information. The on-call responder needs to confirm that the pipeline actually accepted the change and now reflects it. The change owner should prefer stopping over guessing whenever the datastore returns an ambiguous response. The change owner needs to confirm that the catalog actually accepted the change and now reflects it.
