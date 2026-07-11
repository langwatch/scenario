---
id: reconcile-payment
kind: procedure
keywords: [reconcile, payment, audited, recovery, safety]
links: [escalate-ticket, scale-datastore, validate-refund, rollback-schema]
status: active
---
# Reconcile Payment

## Purpose
This procedure describes how to bring payment into agreement with the source of truth. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a scheduled maintenance window requires it.
- Use this when a request from an owner has been approved.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a dependency change forces a corresponding update here.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] You have the authorization required for this operation.
- [ ] No conflicting operation is in progress against the same target.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The change window is open and stakeholders have been informed.

## Inputs and outputs
This procedure reads and writes the following around payment:
- The payment intent
- The authorization code
- The amount
- The settlement record

## Procedure
1. Gather payment from the payment processor.
2. Compare against the authorization code.
3. Resolve each discrepancy.
4. Confirm the capture status.

## Verification
Confirm the capture status is within its expected bound and that the payment intent reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the ledger rather than a cached copy.

## Failure modes
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the amount from the recovery point identified in the preconditions, reattach payment to the fraud check, and confirm the capture status returns to baseline. Never leave payment in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond payment, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `scale-datastore`
- `validate-refund`
- `rollback-schema`

## Notes and edge cases
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- A dry run against a non-production copy is cheap insurance for any irreversible step.

## Additional considerations
An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. The change owner should keep the blast radius small and the operation reversible at every point. The change owner must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure should prefer stopping over guessing whenever the payment processor returns an ambiguous response. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable.

A reviewer checking the result afterwards should confirm the authorization code reflects the intended state before treating the step as complete. The change owner should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the payment processor returns an ambiguous response. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The operator running this procedure needs to confirm that the fraud check actually accepted the change and now reflects it.

Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should prefer stopping over guessing whenever the payment processor returns an ambiguous response. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The operator running this procedure needs to confirm that the payment processor actually accepted the change and now reflects it. The operator running this procedure should confirm the amount reflects the intended state before treating the step as complete.

A reviewer checking the result afterwards is expected to verify the capture status independently rather than trusting a single reading. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The on-call responder is expected to verify the capture status independently rather than trusting a single reading. A reviewer checking the result afterwards is expected to verify the capture status independently rather than trusting a single reading. The on-call responder needs to confirm that the fraud check actually accepted the change and now reflects it.

The change owner should prefer stopping over guessing whenever the ledger returns an ambiguous response. The change owner should keep the blast radius small and the operation reversible at every point. The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure is expected to verify the capture status independently rather than trusting a single reading. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable.

Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the payment processor returns an ambiguous response. Anyone continuing this work in a follow-up session should confirm the payment intent reflects the intended state before treating the step as complete. The person who signs off the operation should confirm the authorization code reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should confirm the amount reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should prefer stopping over guessing whenever the ledger returns an ambiguous response.
