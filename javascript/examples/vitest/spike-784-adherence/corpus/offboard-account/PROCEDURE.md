---
id: offboard-account
kind: procedure
keywords: [offboard, account, runbook, controlled, operation]
links: [escalate-ticket, validate-certificate, decommission-endpoint, reconcile-datastore]
status: active
---
# Offboard Account

## Purpose
This procedure describes how to remove account from the system and revoke its access. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a request from an owner has been approved.
- Use this when a dependency change forces a corresponding update here.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when an alert indicates the target has degraded.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] You have the authorization required for this operation.
- [ ] The change window is open and stakeholders have been informed.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] A recent backup or recovery point exists and has been verified as restorable.

## Inputs and outputs
This procedure reads and writes the following around account:
- The account record
- The entitlement set
- The contact profile
- The tier assignment

## Procedure
1. Confirm account is departing.
2. Revoke access in the directory.
3. Archive the account record.
4. Confirm the activation status.

## Verification
Confirm the activation status is within its expected bound and that the tier assignment reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the directory rather than a cached copy.

## Failure modes
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the account record from the recovery point identified in the preconditions, reattach account to the billing system, and confirm the activation status returns to baseline. Never leave account in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond account, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `validate-certificate`
- `decommission-endpoint`
- `reconcile-datastore`

## Notes and edge cases
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.

## Additional considerations
A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The change owner must record what was observed against the operation id so the history stays reconstructable. The change owner must not disable a check to make progress, because a failing check is information. The change owner should confirm the contact profile reflects the intended state before treating the step as complete. The on-call responder is expected to verify the activation status independently rather than trusting a single reading.

A reviewer checking the result afterwards should confirm the tier assignment reflects the intended state before treating the step as complete. The change owner is expected to verify the activation status independently rather than trusting a single reading. The on-call responder needs to confirm that the provisioning queue actually accepted the change and now reflects it. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why.

The person who signs off the operation needs to confirm that the billing system actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session is expected to verify the activation status independently rather than trusting a single reading. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. The on-call responder must record what was observed against the operation id so the history stays reconstructable.

The change owner should confirm the entitlement set reflects the intended state before treating the step as complete. The operator running this procedure should prefer stopping over guessing whenever the directory returns an ambiguous response. The change owner should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session should confirm the entitlement set reflects the intended state before treating the step as complete. The on-call responder must not disable a check to make progress, because a failing check is information.

A reviewer checking the result afterwards is expected to verify the activation status independently rather than trusting a single reading. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The person who signs off the operation should confirm the account record reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later needs to confirm that the provisioning queue actually accepted the change and now reflects it. A reviewer checking the result afterwards should prefer stopping over guessing whenever the billing system returns an ambiguous response.

The change owner should prefer stopping over guessing whenever the billing system returns an ambiguous response. The operator running this procedure is expected to verify the activation status independently rather than trusting a single reading. The person who signs off the operation is expected to verify the activation status independently rather than trusting a single reading. The on-call responder needs to confirm that the directory actually accepted the change and now reflects it. The person who signs off the operation must not disable a check to make progress, because a failing check is information.
