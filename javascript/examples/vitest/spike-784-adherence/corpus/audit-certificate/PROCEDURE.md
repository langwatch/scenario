---
id: audit-certificate
kind: procedure
keywords: [audit, certificate, recovery, operation, controlled]
links: [escalate-ticket, audit-service, validate-dataset, validate-record]
status: active
---
# Audit Certificate

## Purpose
This procedure describes how to review certificate against policy and record findings. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a request from an owner has been approved.
- Use this when an alert indicates the target has degraded.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a dependency change forces a corresponding update here.
- Use this when a scheduled maintenance window requires it.

## Preconditions
- [ ] You have the authorization required for this operation.
- [ ] The change window is open and stakeholders have been informed.
- [ ] The rollback path has been identified and is known to work.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] A recent backup or recovery point exists and has been verified as restorable.

## Inputs and outputs
This procedure reads and writes the following around certificate:
- The certificate chain
- The private key
- The expiry date
- The subject list

## Procedure
1. Enumerate certificate in the certificate authority.
2. Compare each against policy.
3. Record deviations in the subject list.
4. Confirm the validity window.

## Verification
Confirm the validity window is within its expected bound and that the certificate chain reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the secret store rather than a cached copy.

## Failure modes
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the certificate chain from the recovery point identified in the preconditions, reattach certificate to the certificate authority, and confirm the validity window returns to baseline. Never leave certificate in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond certificate, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `audit-service`
- `validate-dataset`
- `validate-record`

## Notes and edge cases
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.

## Additional considerations
A reviewer checking the result afterwards should confirm the subject list reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session needs to confirm that the certificate authority actually accepted the change and now reflects it. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the certificate authority returns an ambiguous response.

The on-call responder should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later should confirm the certificate chain reflects the intended state before treating the step as complete.

The person who signs off the operation is expected to verify the validity window independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should confirm the certificate chain reflects the intended state before treating the step as complete. The person who signs off the operation must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later is expected to verify the validity window independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why.

The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The on-call responder should prefer stopping over guessing whenever the certificate authority returns an ambiguous response. A reviewer checking the result afterwards is expected to verify the validity window independently rather than trusting a single reading. The on-call responder needs to confirm that the certificate authority actually accepted the change and now reflects it.

The change owner must not disable a check to make progress, because a failing check is information. The on-call responder should confirm the expiry date reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The operator running this procedure should confirm the private key reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should confirm the subject list reflects the intended state before treating the step as complete.

The change owner is expected to verify the validity window independently rather than trusting a single reading. An auditor reconstructing the timeline later should confirm the expiry date reflects the intended state before treating the step as complete. The person who signs off the operation should confirm the expiry date reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should confirm the expiry date reflects the intended state before treating the step as complete. The change owner needs to confirm that the certificate authority actually accepted the change and now reflects it.
