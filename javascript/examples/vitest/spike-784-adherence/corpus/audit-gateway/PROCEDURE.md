---
id: audit-gateway
kind: procedure
keywords: [audit, gateway, safety, recovery, runbook]
links: [escalate-ticket, archive-release, validate-file, snapshot-queue]
status: active
---
# Audit Gateway

## Purpose
This procedure describes how to review gateway against policy and record findings. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a scheduled maintenance window requires it.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a request from an owner has been approved.
- Use this when an alert indicates the target has degraded.
- Use this when a preceding procedure explicitly hands off to this one.

## Preconditions
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] The rollback path has been identified and is known to work.
- [ ] The change window is open and stakeholders have been informed.
- [ ] You have the authorization required for this operation.
- [ ] A recent backup or recovery point exists and has been verified as restorable.

## Inputs and outputs
This procedure reads and writes the following around gateway:
- The routing rules
- The upstream pool
- The header policy
- The connection limits

## Procedure
1. Enumerate gateway in the config store.
2. Compare each against policy.
3. Record deviations in the routing rules.
4. Confirm the health signal.

## Verification
Confirm the health signal is within its expected bound and that the connection limits reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the edge tier rather than a cached copy.

## Failure modes
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the routing rules from the recovery point identified in the preconditions, reattach gateway to the upstream services, and confirm the health signal returns to baseline. Never leave gateway in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond gateway, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `archive-release`
- `validate-file`
- `snapshot-queue`

## Notes and edge cases
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Record who performed the operation and when, so the audit ledger stays trustworthy.

## Additional considerations
An auditor reconstructing the timeline later should confirm the header policy reflects the intended state before treating the step as complete. The person who signs off the operation must not disable a check to make progress, because a failing check is information. The change owner needs to confirm that the config store actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session needs to confirm that the edge tier actually accepted the change and now reflects it. The on-call responder must not disable a check to make progress, because a failing check is information.

The person who signs off the operation should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should keep the blast radius small and the operation reversible at every point. The change owner needs to confirm that the edge tier actually accepted the change and now reflects it. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why.

Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the edge tier returns an ambiguous response. The change owner must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The change owner must record what was observed against the operation id so the history stays reconstructable. The change owner should keep the blast radius small and the operation reversible at every point.

The person who signs off the operation should prefer stopping over guessing whenever the config store returns an ambiguous response. The change owner must not disable a check to make progress, because a failing check is information. The operator running this procedure is expected to verify the health signal independently rather than trusting a single reading. An auditor reconstructing the timeline later is expected to verify the health signal independently rather than trusting a single reading. The change owner needs to confirm that the upstream services actually accepted the change and now reflects it.

An auditor reconstructing the timeline later is expected to verify the health signal independently rather than trusting a single reading. The person who signs off the operation should leave a clear note for the next person about what remains and why. The on-call responder should confirm the header policy reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session needs to confirm that the config store actually accepted the change and now reflects it. The operator running this procedure is expected to verify the health signal independently rather than trusting a single reading.

An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. The on-call responder should prefer stopping over guessing whenever the upstream services returns an ambiguous response. A reviewer checking the result afterwards is expected to verify the health signal independently rather than trusting a single reading. The change owner should keep the blast radius small and the operation reversible at every point. The operator running this procedure is expected to verify the health signal independently rather than trusting a single reading.
