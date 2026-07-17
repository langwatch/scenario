---
id: validate-release
kind: procedure
keywords: [validate, release, controlled, safety, procedure]
links: [escalate-ticket, throttle-endpoint, reconcile-ticket, restore-file]
status: active
---
# Validate Release

## Purpose
This procedure describes how to check that release meets its correctness criteria. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when an alert indicates the target has degraded.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a scheduled maintenance window requires it.
- Use this when a request from an owner has been approved.

## Preconditions
- [ ] You have the authorization required for this operation.
- [ ] The rollback path has been identified and is known to work.
- [ ] The change window is open and stakeholders have been informed.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The relevant dashboards and alerts are visible to you for the duration.

## Inputs and outputs
This procedure reads and writes the following around release:
- The changelog
- The artifact bundle
- The version number
- The sign-off record

## Procedure
1. Load release from the artifact store.
2. Run the checks against the version number.
3. Confirm the promotion gate.
4. Record the outcome.

## Verification
Confirm the promotion gate is within its expected bound and that the sign-off record reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the artifact store rather than a cached copy.

## Failure modes
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the sign-off record from the recovery point identified in the preconditions, reattach release to the distribution channel, and confirm the promotion gate returns to baseline. Never leave release in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond release, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `throttle-endpoint`
- `reconcile-ticket`
- `restore-file`

## Notes and edge cases
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.

## Additional considerations
Anyone continuing this work in a follow-up session needs to confirm that the artifact store actually accepted the change and now reflects it. The change owner needs to confirm that the release registry actually accepted the change and now reflects it. The change owner must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the distribution channel returns an ambiguous response. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable.

A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The on-call responder must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the release registry returns an ambiguous response. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the release registry returns an ambiguous response.

An auditor reconstructing the timeline later should confirm the sign-off record reflects the intended state before treating the step as complete. The change owner must not disable a check to make progress, because a failing check is information. The change owner must not disable a check to make progress, because a failing check is information. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the release registry returns an ambiguous response.

The on-call responder is expected to verify the promotion gate independently rather than trusting a single reading. The on-call responder should prefer stopping over guessing whenever the artifact store returns an ambiguous response. A reviewer checking the result afterwards is expected to verify the promotion gate independently rather than trusting a single reading. The operator running this procedure should keep the blast radius small and the operation reversible at every point. The person who signs off the operation should prefer stopping over guessing whenever the distribution channel returns an ambiguous response.

The on-call responder should prefer stopping over guessing whenever the distribution channel returns an ambiguous response. The person who signs off the operation must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should confirm the changelog reflects the intended state before treating the step as complete.

A reviewer checking the result afterwards should prefer stopping over guessing whenever the artifact store returns an ambiguous response. The change owner is expected to verify the promotion gate independently rather than trusting a single reading. The on-call responder should keep the blast radius small and the operation reversible at every point. The change owner is expected to verify the promotion gate independently rather than trusting a single reading. The on-call responder must record what was observed against the operation id so the history stays reconstructable.
