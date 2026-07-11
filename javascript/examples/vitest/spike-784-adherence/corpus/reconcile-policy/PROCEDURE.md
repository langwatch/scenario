---
id: reconcile-policy
kind: procedure
keywords: [reconcile, policy, runbook, reversible, safety]
links: [escalate-ticket, reconfigure-cache, rollback-schema, restart-service]
status: active
---
# Reconcile Policy

## Purpose
This procedure describes how to bring policy into agreement with the source of truth. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when an alert indicates the target has degraded.
- Use this when a request from an owner has been approved.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a dependency change forces a corresponding update here.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] No conflicting operation is in progress against the same target.
- [ ] You have the authorization required for this operation.
- [ ] A recent backup or recovery point exists and has been verified as restorable.

## Inputs and outputs
This procedure reads and writes the following around policy:
- The policy document
- The effective date
- The scope list
- The exception log

## Procedure
1. Gather policy from the enforcement layer.
2. Compare against the exception log.
3. Resolve each discrepancy.
4. Confirm the compliance state.

## Verification
Confirm the compliance state is within its expected bound and that the effective date reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the enforcement layer rather than a cached copy.

## Failure modes
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the policy document from the recovery point identified in the preconditions, reattach policy to the enforcement layer, and confirm the compliance state returns to baseline. Never leave policy in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond policy, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `reconfigure-cache`
- `rollback-schema`
- `restart-service`

## Notes and edge cases
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.

## Additional considerations
A reviewer checking the result afterwards should confirm the scope list reflects the intended state before treating the step as complete. The change owner must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should confirm the effective date reflects the intended state before treating the step as complete. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation is expected to verify the compliance state independently rather than trusting a single reading.

A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The operator running this procedure must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session needs to confirm that the review board actually accepted the change and now reflects it. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point.

A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards needs to confirm that the enforcement layer actually accepted the change and now reflects it. The person who signs off the operation should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable.

The change owner needs to confirm that the review board actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The change owner should prefer stopping over guessing whenever the policy store returns an ambiguous response. The change owner needs to confirm that the review board actually accepted the change and now reflects it. The on-call responder should keep the blast radius small and the operation reversible at every point.

Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the enforcement layer returns an ambiguous response. The change owner should confirm the policy document reflects the intended state before treating the step as complete. The on-call responder should confirm the policy document reflects the intended state before treating the step as complete. The change owner is expected to verify the compliance state independently rather than trusting a single reading. The operator running this procedure should prefer stopping over guessing whenever the policy store returns an ambiguous response.

A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The change owner should prefer stopping over guessing whenever the enforcement layer returns an ambiguous response. Anyone continuing this work in a follow-up session needs to confirm that the policy store actually accepted the change and now reflects it. The change owner must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should prefer stopping over guessing whenever the policy store returns an ambiguous response.
