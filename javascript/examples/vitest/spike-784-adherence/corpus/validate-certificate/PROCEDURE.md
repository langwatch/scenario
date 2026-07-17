---
id: validate-certificate
kind: procedure
keywords: [validate, certificate, operation, safety, recovery]
links: [escalate-ticket, dispatch-report, drain-datastore, snapshot-datastore]
status: active
---
# Validate Certificate

## Purpose
This procedure describes how to check that certificate meets its correctness criteria. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a request from an owner has been approved.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when an alert indicates the target has degraded.
- Use this when a dependency change forces a corresponding update here.

## Preconditions
- [ ] No conflicting operation is in progress against the same target.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The rollback path has been identified and is known to work.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The change window is open and stakeholders have been informed.

## Inputs and outputs
This procedure reads and writes the following around certificate:
- The certificate chain
- The private key
- The expiry date
- The subject list

## Procedure
1. Load certificate from the secret store.
2. Run the checks against the expiry date.
3. Confirm the validity window.
4. Record the outcome.

## Verification
Confirm the validity window is within its expected bound and that the private key reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the secret store rather than a cached copy.

## Failure modes
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the private key from the recovery point identified in the preconditions, reattach certificate to the edge tier, and confirm the validity window returns to baseline. Never leave certificate in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond certificate, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `dispatch-report`
- `drain-datastore`
- `snapshot-datastore`

## Notes and edge cases
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.

## Additional considerations
A reviewer checking the result afterwards needs to confirm that the secret store actually accepted the change and now reflects it. The person who signs off the operation should prefer stopping over guessing whenever the edge tier returns an ambiguous response. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should confirm the expiry date reflects the intended state before treating the step as complete. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable.

Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The change owner should confirm the private key reflects the intended state before treating the step as complete. The change owner must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure is expected to verify the validity window independently rather than trusting a single reading. The change owner needs to confirm that the edge tier actually accepted the change and now reflects it.

An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards needs to confirm that the edge tier actually accepted the change and now reflects it. An auditor reconstructing the timeline later should confirm the private key reflects the intended state before treating the step as complete. The operator running this procedure should prefer stopping over guessing whenever the certificate authority returns an ambiguous response.

The operator running this procedure should keep the blast radius small and the operation reversible at every point. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. The on-call responder is expected to verify the validity window independently rather than trusting a single reading. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information.

The person who signs off the operation should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the certificate authority returns an ambiguous response. A reviewer checking the result afterwards needs to confirm that the edge tier actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information.

Anyone continuing this work in a follow-up session needs to confirm that the secret store actually accepted the change and now reflects it. The change owner should leave a clear note for the next person about what remains and why. The person who signs off the operation must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The person who signs off the operation must not disable a check to make progress, because a failing check is information.
