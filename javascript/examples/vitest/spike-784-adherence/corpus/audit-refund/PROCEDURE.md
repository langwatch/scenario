---
id: audit-refund
kind: procedure
keywords: [audit, refund, audited, recovery, reversible]
links: [escalate-ticket, throttle-notification, validate-cache, migrate-service]
status: active
---
# Audit Refund

## Purpose
This procedure describes how to review refund against policy and record findings. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when an alert indicates the target has degraded.
- Use this when a scheduled maintenance window requires it.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a dependency change forces a corresponding update here.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] The change window is open and stakeholders have been informed.
- [ ] You have the authorization required for this operation.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The relevant dashboards and alerts are visible to you for the duration.

## Inputs and outputs
This procedure reads and writes the following around refund:
- The refund request
- The original charge
- The refund amount
- The reason code

## Procedure
1. Enumerate refund in the ledger.
2. Compare each against policy.
3. Record deviations in the original charge.
4. Confirm the refund state.

## Verification
Confirm the refund state is within its expected bound and that the refund amount reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the case queue rather than a cached copy.

## Failure modes
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the refund request from the recovery point identified in the preconditions, reattach refund to the ledger, and confirm the refund state returns to baseline. Never leave refund in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond refund, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `throttle-notification`
- `validate-cache`
- `migrate-service`

## Notes and edge cases
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.

## Additional considerations
A reviewer checking the result afterwards is expected to verify the refund state independently rather than trusting a single reading. The on-call responder should keep the blast radius small and the operation reversible at every point. The operator running this procedure should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later is expected to verify the refund state independently rather than trusting a single reading. The operator running this procedure must not disable a check to make progress, because a failing check is information.

The change owner must not disable a check to make progress, because a failing check is information. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later needs to confirm that the case queue actually accepted the change and now reflects it. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable.

The operator running this procedure should prefer stopping over guessing whenever the case queue returns an ambiguous response. Anyone continuing this work in a follow-up session should confirm the original charge reflects the intended state before treating the step as complete. The change owner must record what was observed against the operation id so the history stays reconstructable. The on-call responder should confirm the reason code reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why.

An auditor reconstructing the timeline later is expected to verify the refund state independently rather than trusting a single reading. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation must not disable a check to make progress, because a failing check is information. The on-call responder is expected to verify the refund state independently rather than trusting a single reading. A reviewer checking the result afterwards should confirm the original charge reflects the intended state before treating the step as complete.

An auditor reconstructing the timeline later should confirm the reason code reflects the intended state before treating the step as complete. The on-call responder should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The operator running this procedure should prefer stopping over guessing whenever the ledger returns an ambiguous response. The change owner needs to confirm that the ledger actually accepted the change and now reflects it.

An auditor reconstructing the timeline later should prefer stopping over guessing whenever the case queue returns an ambiguous response. The change owner must not disable a check to make progress, because a failing check is information. The person who signs off the operation is expected to verify the refund state independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should confirm the original charge reflects the intended state before treating the step as complete. The person who signs off the operation needs to confirm that the ledger actually accepted the change and now reflects it.
