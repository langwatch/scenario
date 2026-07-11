---
id: provision-certificate
kind: procedure
keywords: [provision, certificate, operation, reversible, runbook]
links: [escalate-ticket, throttle-notification, archive-certificate, publish-dataset]
status: active
---
# Provision Certificate

## Purpose
This procedure describes how to create and prepare certificate for first use. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a dependency change forces a corresponding update here.
- Use this when an alert indicates the target has degraded.
- Use this when a scheduled maintenance window requires it.
- Use this when a request from an owner has been approved.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] The change window is open and stakeholders have been informed.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The rollback path has been identified and is known to work.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] You have the authorization required for this operation.

## Inputs and outputs
This procedure reads and writes the following around certificate:
- The certificate chain
- The private key
- The expiry date
- The subject list

## Procedure
1. Allocate certificate in the certificate authority.
2. Apply the baseline configuration.
3. Attach the expiry date.
4. Confirm the validity window.

## Verification
Confirm the validity window is within its expected bound and that the private key reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the secret store rather than a cached copy.

## Failure modes
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the expiry date from the recovery point identified in the preconditions, reattach certificate to the edge tier, and confirm the validity window returns to baseline. Never leave certificate in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond certificate, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `throttle-notification`
- `archive-certificate`
- `publish-dataset`

## Notes and edge cases
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.

## Additional considerations
The change owner is expected to verify the validity window independently rather than trusting a single reading. The change owner should prefer stopping over guessing whenever the certificate authority returns an ambiguous response. The operator running this procedure should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the secret store returns an ambiguous response. The change owner is expected to verify the validity window independently rather than trusting a single reading.

A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The change owner must not disable a check to make progress, because a failing check is information. The operator running this procedure needs to confirm that the edge tier actually accepted the change and now reflects it. A reviewer checking the result afterwards should prefer stopping over guessing whenever the certificate authority returns an ambiguous response.

The change owner must not disable a check to make progress, because a failing check is information. The operator running this procedure should confirm the private key reflects the intended state before treating the step as complete. The on-call responder must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later is expected to verify the validity window independently rather than trusting a single reading. The operator running this procedure needs to confirm that the certificate authority actually accepted the change and now reflects it.

The on-call responder is expected to verify the validity window independently rather than trusting a single reading. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. The person who signs off the operation is expected to verify the validity window independently rather than trusting a single reading. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session needs to confirm that the certificate authority actually accepted the change and now reflects it.

The change owner must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The person who signs off the operation should leave a clear note for the next person about what remains and why. The change owner should confirm the subject list reflects the intended state before treating the step as complete.

The on-call responder should keep the blast radius small and the operation reversible at every point. The on-call responder needs to confirm that the secret store actually accepted the change and now reflects it. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The on-call responder should confirm the expiry date reflects the intended state before treating the step as complete. The on-call responder should prefer stopping over guessing whenever the certificate authority returns an ambiguous response.
