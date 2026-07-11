---
id: audit-policy
kind: procedure
keywords: [audit, policy, safety, controlled, runbook]
links: [escalate-ticket, provision-cluster, snapshot-cluster, migrate-datastore]
status: active
---
# Audit Policy

## Purpose
This procedure describes how to review policy against policy and record findings. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a dependency change forces a corresponding update here.
- Use this when a scheduled maintenance window requires it.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when an alert indicates the target has degraded.
- Use this when a preceding procedure explicitly hands off to this one.

## Preconditions
- [ ] The change window is open and stakeholders have been informed.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The rollback path has been identified and is known to work.
- [ ] No conflicting operation is in progress against the same target.
- [ ] A recent backup or recovery point exists and has been verified as restorable.

## Inputs and outputs
This procedure reads and writes the following around policy:
- The policy document
- The effective date
- The scope list
- The exception log

## Procedure
1. Enumerate policy in the enforcement layer.
2. Compare each against policy.
3. Record deviations in the effective date.
4. Confirm the compliance state.

## Verification
Confirm the compliance state is within its expected bound and that the scope list reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the policy store rather than a cached copy.

## Failure modes
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the effective date from the recovery point identified in the preconditions, reattach policy to the policy store, and confirm the compliance state returns to baseline. Never leave policy in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond policy, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `provision-cluster`
- `snapshot-cluster`
- `migrate-datastore`

## Notes and edge cases
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.

## Additional considerations
The person who signs off the operation is expected to verify the compliance state independently rather than trusting a single reading. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The on-call responder should leave a clear note for the next person about what remains and why. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable.

Anyone continuing this work in a follow-up session should confirm the scope list reflects the intended state before treating the step as complete. The person who signs off the operation should prefer stopping over guessing whenever the review board returns an ambiguous response. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The on-call responder should prefer stopping over guessing whenever the enforcement layer returns an ambiguous response. A reviewer checking the result afterwards should confirm the policy document reflects the intended state before treating the step as complete.

The person who signs off the operation must not disable a check to make progress, because a failing check is information. The person who signs off the operation needs to confirm that the policy store actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should confirm the exception log reflects the intended state before treating the step as complete. The operator running this procedure is expected to verify the compliance state independently rather than trusting a single reading. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable.

The on-call responder is expected to verify the compliance state independently rather than trusting a single reading. A reviewer checking the result afterwards is expected to verify the compliance state independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should confirm the effective date reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later should confirm the policy document reflects the intended state before treating the step as complete. The change owner should prefer stopping over guessing whenever the review board returns an ambiguous response.

A reviewer checking the result afterwards should confirm the exception log reflects the intended state before treating the step as complete. The on-call responder must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later should confirm the scope list reflects the intended state before treating the step as complete. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information.

Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the review board returns an ambiguous response. An auditor reconstructing the timeline later is expected to verify the compliance state independently rather than trusting a single reading. The change owner should confirm the exception log reflects the intended state before treating the step as complete. The operator running this procedure should keep the blast radius small and the operation reversible at every point.
