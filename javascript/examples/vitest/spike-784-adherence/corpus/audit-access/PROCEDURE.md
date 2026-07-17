---
id: audit-access
kind: procedure
keywords: [audit, access, recovery, runbook, safety]
links: [escalate-ticket, audit-gateway, publish-policy, replicate-dataset]
status: active
---
# Audit Access Grant

## Purpose
This procedure describes how to review access grant against policy and record findings. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a scheduled maintenance window requires it.
- Use this when an alert indicates the target has degraded.
- Use this when a dependency change forces a corresponding update here.
- Use this when a request from an owner has been approved.
- Use this when a preceding procedure explicitly hands off to this one.

## Preconditions
- [ ] No conflicting operation is in progress against the same target.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The rollback path has been identified and is known to work.
- [ ] The change window is open and stakeholders have been informed.
- [ ] You have the authorization required for this operation.

## Inputs and outputs
This procedure reads and writes the following around access grant:
- The role binding
- The scope set
- The expiry
- The approval record

## Procedure
1. Enumerate access grant in the identity provider.
2. Compare each against policy.
3. Record deviations in the expiry.
4. Confirm the grant status.

## Verification
Confirm the grant status is within its expected bound and that the role binding reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the directory rather than a cached copy.

## Failure modes
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the scope set from the recovery point identified in the preconditions, reattach access grant to the audit ledger, and confirm the grant status returns to baseline. Never leave access grant in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond access grant, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `audit-gateway`
- `publish-policy`
- `replicate-dataset`

## Notes and edge cases
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- A dry run against a non-production copy is cheap insurance for any irreversible step.

## Additional considerations
A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The operator running this procedure is expected to verify the grant status independently rather than trusting a single reading. The operator running this procedure is expected to verify the grant status independently rather than trusting a single reading. The change owner needs to confirm that the identity provider actually accepted the change and now reflects it. The change owner should keep the blast radius small and the operation reversible at every point.

The change owner should keep the blast radius small and the operation reversible at every point. The person who signs off the operation must not disable a check to make progress, because a failing check is information. The on-call responder is expected to verify the grant status independently rather than trusting a single reading. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why.

Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The change owner should leave a clear note for the next person about what remains and why. The operator running this procedure is expected to verify the grant status independently rather than trusting a single reading. The operator running this procedure should prefer stopping over guessing whenever the identity provider returns an ambiguous response.

The on-call responder must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The on-call responder is expected to verify the grant status independently rather than trusting a single reading. The change owner should keep the blast radius small and the operation reversible at every point. The person who signs off the operation should leave a clear note for the next person about what remains and why.

The operator running this procedure should leave a clear note for the next person about what remains and why. The person who signs off the operation should leave a clear note for the next person about what remains and why. The on-call responder should prefer stopping over guessing whenever the directory returns an ambiguous response. A reviewer checking the result afterwards should confirm the scope set reflects the intended state before treating the step as complete. The change owner must not disable a check to make progress, because a failing check is information.

The on-call responder must not disable a check to make progress, because a failing check is information. The operator running this procedure should confirm the approval record reflects the intended state before treating the step as complete. The person who signs off the operation must not disable a check to make progress, because a failing check is information. The on-call responder should prefer stopping over guessing whenever the directory returns an ambiguous response. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point.
