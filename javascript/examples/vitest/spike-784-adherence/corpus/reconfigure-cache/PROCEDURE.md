---
id: reconfigure-cache
kind: procedure
keywords: [reconfigure, cache, operation, runbook, audited]
links: [escalate-ticket, archive-notification, restore-credential, snapshot-service]
status: active
---
# Reconfigure Cache

## Purpose
This procedure describes how to change the configuration of cache in a controlled way. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when an alert indicates the target has degraded.
- Use this when a scheduled maintenance window requires it.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a dependency change forces a corresponding update here.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The change window is open and stakeholders have been informed.
- [ ] No conflicting operation is in progress against the same target.
- [ ] You have the authorization required for this operation.

## Inputs and outputs
This procedure reads and writes the following around cache:
- The cache keys
- The eviction policy
- The warm set
- The hit ratio

## Procedure
1. Capture the current configuration of cache.
2. Apply the new settings to the cache tier.
3. Validate against the staleness bound.
4. Persist the hit ratio.

## Verification
Confirm the staleness bound is within its expected bound and that the hit ratio reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the cache tier rather than a cached copy.

## Failure modes
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the warm set from the recovery point identified in the preconditions, reattach cache to the invalidation channel, and confirm the staleness bound returns to baseline. Never leave cache in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond cache, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `archive-notification`
- `restore-credential`
- `snapshot-service`

## Notes and edge cases
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.

## Additional considerations
The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. An auditor reconstructing the timeline later should confirm the hit ratio reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the invalidation channel returns an ambiguous response. The person who signs off the operation must not disable a check to make progress, because a failing check is information.

A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. The change owner should leave a clear note for the next person about what remains and why. The person who signs off the operation needs to confirm that the origin store actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point.

The change owner should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should prefer stopping over guessing whenever the origin store returns an ambiguous response. An auditor reconstructing the timeline later is expected to verify the staleness bound independently rather than trusting a single reading. The person who signs off the operation should keep the blast radius small and the operation reversible at every point.

The change owner must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards should prefer stopping over guessing whenever the origin store returns an ambiguous response. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable.

The change owner needs to confirm that the origin store actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The change owner should prefer stopping over guessing whenever the origin store returns an ambiguous response. A reviewer checking the result afterwards should confirm the eviction policy reflects the intended state before treating the step as complete. The operator running this procedure should confirm the eviction policy reflects the intended state before treating the step as complete.

The person who signs off the operation is expected to verify the staleness bound independently rather than trusting a single reading. The person who signs off the operation should confirm the eviction policy reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should prefer stopping over guessing whenever the invalidation channel returns an ambiguous response. Anyone continuing this work in a follow-up session should confirm the warm set reflects the intended state before treating the step as complete. The person who signs off the operation should prefer stopping over guessing whenever the origin store returns an ambiguous response.
