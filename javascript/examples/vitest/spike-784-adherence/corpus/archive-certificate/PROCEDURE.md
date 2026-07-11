---
id: archive-certificate
kind: procedure
keywords: [archive, certificate, audited, runbook, operation]
links: [escalate-ticket, rotate-certificate, scale-cluster, validate-report]
status: active
---
# Archive Certificate

## Purpose
This procedure describes how to move certificate to long-term storage under its retention rules. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when an alert indicates the target has degraded.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a request from an owner has been approved.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a dependency change forces a corresponding update here.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The change window is open and stakeholders have been informed.
- [ ] A recent backup or recovery point exists and has been verified as restorable.

## Inputs and outputs
This procedure reads and writes the following around certificate:
- The certificate chain
- The private key
- The expiry date
- The subject list

## Procedure
1. Confirm certificate is eligible for archival.
2. Move the expiry date to the certificate authority.
3. Verify the validity window.
4. Update the index.

## Verification
Confirm the validity window is within its expected bound and that the private key reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the certificate authority rather than a cached copy.

## Failure modes
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the subject list from the recovery point identified in the preconditions, reattach certificate to the edge tier, and confirm the validity window returns to baseline. Never leave certificate in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond certificate, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `rotate-certificate`
- `scale-cluster`
- `validate-report`

## Notes and edge cases
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.

## Additional considerations
The on-call responder should confirm the certificate chain reflects the intended state before treating the step as complete. The on-call responder needs to confirm that the edge tier actually accepted the change and now reflects it. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards needs to confirm that the edge tier actually accepted the change and now reflects it. A reviewer checking the result afterwards should prefer stopping over guessing whenever the certificate authority returns an ambiguous response.

The operator running this procedure should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later should confirm the subject list reflects the intended state before treating the step as complete. The change owner needs to confirm that the certificate authority actually accepted the change and now reflects it. The change owner should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable.

A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. The change owner should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards needs to confirm that the edge tier actually accepted the change and now reflects it.

Anyone continuing this work in a follow-up session needs to confirm that the edge tier actually accepted the change and now reflects it. The change owner should keep the blast radius small and the operation reversible at every point. The change owner must record what was observed against the operation id so the history stays reconstructable. The change owner should leave a clear note for the next person about what remains and why. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable.

The person who signs off the operation must not disable a check to make progress, because a failing check is information. The on-call responder should keep the blast radius small and the operation reversible at every point. The operator running this procedure should confirm the private key reflects the intended state before treating the step as complete. A reviewer checking the result afterwards is expected to verify the validity window independently rather than trusting a single reading. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable.

An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The on-call responder should confirm the certificate chain reflects the intended state before treating the step as complete. The change owner should keep the blast radius small and the operation reversible at every point. The operator running this procedure should prefer stopping over guessing whenever the certificate authority returns an ambiguous response. The on-call responder must not disable a check to make progress, because a failing check is information.
