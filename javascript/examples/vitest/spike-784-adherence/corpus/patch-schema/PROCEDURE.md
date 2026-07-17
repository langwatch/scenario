---
id: patch-schema
kind: procedure
keywords: [patch, schema, controlled, audited, safety]
links: [escalate-ticket, purge-file, audit-service, archive-ticket]
status: active
---
# Patch Schema

## Purpose
This procedure describes how to apply a corrective change to schema with minimal disruption. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a request from an owner has been approved.
- Use this when a dependency change forces a corresponding update here.
- Use this when a scheduled maintenance window requires it.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when an alert indicates the target has degraded.

## Preconditions
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The rollback path has been identified and is known to work.
- [ ] You have the authorization required for this operation.
- [ ] The change window is open and stakeholders have been informed.
- [ ] No conflicting operation is in progress against the same target.

## Inputs and outputs
This procedure reads and writes the following around schema:
- The migration script
- The column set
- The constraint list
- The version marker

## Procedure
1. Obtain the approved patch for schema.
2. Apply it to the compatibility gate.
3. Re-run the migration status.
4. Record the patch level in the constraint list.

## Verification
Confirm the migration status is within its expected bound and that the constraint list reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the migration runner rather than a cached copy.

## Failure modes
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the column set from the recovery point identified in the preconditions, reattach schema to the migration runner, and confirm the migration status returns to baseline. Never leave schema in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond schema, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `purge-file`
- `audit-service`
- `archive-ticket`

## Notes and edge cases
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.

## Additional considerations
An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The operator running this procedure needs to confirm that the compatibility gate actually accepted the change and now reflects it. The person who signs off the operation should confirm the column set reflects the intended state before treating the step as complete. The person who signs off the operation should prefer stopping over guessing whenever the datastore returns an ambiguous response. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable.

The operator running this procedure should keep the blast radius small and the operation reversible at every point. The person who signs off the operation should leave a clear note for the next person about what remains and why. The change owner should leave a clear note for the next person about what remains and why. The on-call responder needs to confirm that the compatibility gate actually accepted the change and now reflects it. A reviewer checking the result afterwards should prefer stopping over guessing whenever the migration runner returns an ambiguous response.

An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure is expected to verify the migration status independently rather than trusting a single reading. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The on-call responder must not disable a check to make progress, because a failing check is information. The change owner must not disable a check to make progress, because a failing check is information.

The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. The on-call responder should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure should leave a clear note for the next person about what remains and why. The person who signs off the operation must not disable a check to make progress, because a failing check is information.

The person who signs off the operation should leave a clear note for the next person about what remains and why. The on-call responder should keep the blast radius small and the operation reversible at every point. The person who signs off the operation is expected to verify the migration status independently rather than trusting a single reading. The operator running this procedure should prefer stopping over guessing whenever the compatibility gate returns an ambiguous response. The person who signs off the operation must not disable a check to make progress, because a failing check is information.

An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards should confirm the version marker reflects the intended state before treating the step as complete. The change owner is expected to verify the migration status independently rather than trusting a single reading. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information.
