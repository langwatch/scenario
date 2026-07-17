---
id: validate-record
kind: procedure
keywords: [validate, record, reversible, controlled, audited]
links: [escalate-ticket, archive-file, quarantine-file, audit-cluster]
status: active
---
# Validate Record

## Purpose
This procedure describes how to check that record meets its correctness criteria. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a dependency change forces a corresponding update here.
- Use this when an alert indicates the target has degraded.
- Use this when a scheduled maintenance window requires it.
- Use this when a request from an owner has been approved.

## Preconditions
- [ ] The change window is open and stakeholders have been informed.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The rollback path has been identified and is known to work.

## Inputs and outputs
This procedure reads and writes the following around record:
- The record body
- The retention label
- The checksum
- The index entry

## Procedure
1. Load record from the search index.
2. Run the checks against the index entry.
3. Confirm the integrity check.
4. Record the outcome.

## Verification
Confirm the integrity check is within its expected bound and that the checksum reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the datastore rather than a cached copy.

## Failure modes
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the retention label from the recovery point identified in the preconditions, reattach record to the search index, and confirm the integrity check returns to baseline. Never leave record in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond record, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `archive-file`
- `quarantine-file`
- `audit-cluster`

## Notes and edge cases
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Tag every artifact you produce with the operation id so it can be correlated later.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.

## Additional considerations
Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The on-call responder should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The on-call responder must not disable a check to make progress, because a failing check is information. The operator running this procedure should confirm the record body reflects the intended state before treating the step as complete.

Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the search index returns an ambiguous response. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the archive tier returns an ambiguous response. An auditor reconstructing the timeline later needs to confirm that the archive tier actually accepted the change and now reflects it. The on-call responder must not disable a check to make progress, because a failing check is information. The operator running this procedure needs to confirm that the search index actually accepted the change and now reflects it.

The person who signs off the operation should prefer stopping over guessing whenever the datastore returns an ambiguous response. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session is expected to verify the integrity check independently rather than trusting a single reading. The operator running this procedure should keep the blast radius small and the operation reversible at every point.

The change owner should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The person who signs off the operation should prefer stopping over guessing whenever the search index returns an ambiguous response. The on-call responder must not disable a check to make progress, because a failing check is information. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable.

Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later needs to confirm that the archive tier actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The on-call responder must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure should prefer stopping over guessing whenever the search index returns an ambiguous response.

The on-call responder should confirm the checksum reflects the intended state before treating the step as complete. The person who signs off the operation should confirm the retention label reflects the intended state before treating the step as complete. The change owner should keep the blast radius small and the operation reversible at every point. The person who signs off the operation is expected to verify the integrity check independently rather than trusting a single reading. The on-call responder should keep the blast radius small and the operation reversible at every point.
