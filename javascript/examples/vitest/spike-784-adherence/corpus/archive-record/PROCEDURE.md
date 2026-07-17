---
id: archive-record
kind: procedure
keywords: [archive, record, reversible, audited, operation]
links: [escalate-ticket, audit-cluster, validate-policy, snapshot-dataset]
status: active
---
# Archive Record

## Purpose
This procedure describes how to move record to long-term storage under its retention rules. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a dependency change forces a corresponding update here.
- Use this when a request from an owner has been approved.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when an alert indicates the target has degraded.
- Use this when a preceding procedure explicitly hands off to this one.

## Preconditions
- [ ] You have the authorization required for this operation.
- [ ] The rollback path has been identified and is known to work.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The change window is open and stakeholders have been informed.
- [ ] A recent backup or recovery point exists and has been verified as restorable.

## Inputs and outputs
This procedure reads and writes the following around record:
- The record body
- The retention label
- The checksum
- The index entry

## Procedure
1. Confirm record is eligible for archival.
2. Move the checksum to the search index.
3. Verify the integrity check.
4. Update the index.

## Verification
Confirm the integrity check is within its expected bound and that the record body reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the datastore rather than a cached copy.

## Failure modes
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the record body from the recovery point identified in the preconditions, reattach record to the datastore, and confirm the integrity check returns to baseline. Never leave record in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond record, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `audit-cluster`
- `validate-policy`
- `snapshot-dataset`

## Notes and edge cases
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.

## Additional considerations
A reviewer checking the result afterwards should prefer stopping over guessing whenever the datastore returns an ambiguous response. The on-call responder must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The on-call responder should prefer stopping over guessing whenever the datastore returns an ambiguous response. The person who signs off the operation should leave a clear note for the next person about what remains and why.

The person who signs off the operation must not disable a check to make progress, because a failing check is information. The on-call responder should confirm the record body reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the datastore returns an ambiguous response. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information.

The person who signs off the operation needs to confirm that the archive tier actually accepted the change and now reflects it. The change owner must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards is expected to verify the integrity check independently rather than trusting a single reading. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure should confirm the index entry reflects the intended state before treating the step as complete.

The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards is expected to verify the integrity check independently rather than trusting a single reading. The person who signs off the operation needs to confirm that the archive tier actually accepted the change and now reflects it. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session needs to confirm that the archive tier actually accepted the change and now reflects it.

An auditor reconstructing the timeline later should confirm the record body reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The on-call responder must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The operator running this procedure must not disable a check to make progress, because a failing check is information.

An auditor reconstructing the timeline later should prefer stopping over guessing whenever the search index returns an ambiguous response. The operator running this procedure should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure should confirm the record body reflects the intended state before treating the step as complete. The person who signs off the operation should leave a clear note for the next person about what remains and why.
