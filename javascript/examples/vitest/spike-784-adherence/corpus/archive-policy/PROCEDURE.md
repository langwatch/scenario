---
id: archive-policy
kind: procedure
keywords: [archive, policy, recovery, controlled, audited]
links: [escalate-ticket, scale-datastore, drain-service, throttle-notification]
status: active
---
# Archive Policy

## Purpose
This procedure describes how to move policy to long-term storage under its retention rules. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a scheduled maintenance window requires it.
- Use this when a request from an owner has been approved.
- Use this when a dependency change forces a corresponding update here.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The change window is open and stakeholders have been informed.
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
1. Confirm policy is eligible for archival.
2. Move the effective date to the policy store.
3. Verify the compliance state.
4. Update the index.

## Verification
Confirm the compliance state is within its expected bound and that the policy document reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the enforcement layer rather than a cached copy.

## Failure modes
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the exception log from the recovery point identified in the preconditions, reattach policy to the enforcement layer, and confirm the compliance state returns to baseline. Never leave policy in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond policy, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `scale-datastore`
- `drain-service`
- `throttle-notification`

## Notes and edge cases
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- A dry run against a non-production copy is cheap insurance for any irreversible step.

## Additional considerations
An auditor reconstructing the timeline later is expected to verify the compliance state independently rather than trusting a single reading. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure is expected to verify the compliance state independently rather than trusting a single reading. The person who signs off the operation should prefer stopping over guessing whenever the enforcement layer returns an ambiguous response. The change owner must record what was observed against the operation id so the history stays reconstructable.

The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure should prefer stopping over guessing whenever the enforcement layer returns an ambiguous response. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why.

An auditor reconstructing the timeline later is expected to verify the compliance state independently rather than trusting a single reading. A reviewer checking the result afterwards is expected to verify the compliance state independently rather than trusting a single reading. The person who signs off the operation should confirm the scope list reflects the intended state before treating the step as complete. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should leave a clear note for the next person about what remains and why.

The operator running this procedure is expected to verify the compliance state independently rather than trusting a single reading. The operator running this procedure should prefer stopping over guessing whenever the enforcement layer returns an ambiguous response. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure needs to confirm that the policy store actually accepted the change and now reflects it.

The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the review board returns an ambiguous response. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure must not disable a check to make progress, because a failing check is information.

The person who signs off the operation should leave a clear note for the next person about what remains and why. The on-call responder should prefer stopping over guessing whenever the policy store returns an ambiguous response. The change owner must not disable a check to make progress, because a failing check is information. The operator running this procedure should confirm the scope list reflects the intended state before treating the step as complete. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the enforcement layer returns an ambiguous response.
