---
id: validate-cache
kind: procedure
keywords: [validate, cache, controlled, procedure, audited]
links: [escalate-ticket, quarantine-file, reconcile-dataset, decommission-gateway]
status: active
---
# Validate Cache

## Purpose
This procedure describes how to check that cache meets its correctness criteria. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when an alert indicates the target has degraded.
- Use this when a dependency change forces a corresponding update here.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a scheduled maintenance window requires it.

## Preconditions
- [ ] The rollback path has been identified and is known to work.
- [ ] You have the authorization required for this operation.
- [ ] No conflicting operation is in progress against the same target.
- [ ] The change window is open and stakeholders have been informed.
- [ ] The relevant dashboards and alerts are visible to you for the duration.

## Inputs and outputs
This procedure reads and writes the following around cache:
- The cache keys
- The eviction policy
- The warm set
- The hit ratio

## Procedure
1. Load cache from the cache tier.
2. Run the checks against the warm set.
3. Confirm the staleness bound.
4. Record the outcome.

## Verification
Confirm the staleness bound is within its expected bound and that the warm set reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the cache tier rather than a cached copy.

## Failure modes
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the eviction policy from the recovery point identified in the preconditions, reattach cache to the cache tier, and confirm the staleness bound returns to baseline. Never leave cache in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond cache, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `quarantine-file`
- `reconcile-dataset`
- `decommission-gateway`

## Notes and edge cases
- Tag every artifact you produce with the operation id so it can be correlated later.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Record who performed the operation and when, so the audit ledger stays trustworthy.

## Additional considerations
An auditor reconstructing the timeline later needs to confirm that the cache tier actually accepted the change and now reflects it. The change owner should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session needs to confirm that the cache tier actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The change owner should confirm the cache keys reflects the intended state before treating the step as complete.

An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The person who signs off the operation should prefer stopping over guessing whenever the origin store returns an ambiguous response. Anyone continuing this work in a follow-up session is expected to verify the staleness bound independently rather than trusting a single reading. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why.

An auditor reconstructing the timeline later needs to confirm that the origin store actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session is expected to verify the staleness bound independently rather than trusting a single reading. A reviewer checking the result afterwards should prefer stopping over guessing whenever the cache tier returns an ambiguous response. A reviewer checking the result afterwards is expected to verify the staleness bound independently rather than trusting a single reading. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable.

An auditor reconstructing the timeline later should confirm the warm set reflects the intended state before treating the step as complete. The operator running this procedure is expected to verify the staleness bound independently rather than trusting a single reading. The person who signs off the operation needs to confirm that the invalidation channel actually accepted the change and now reflects it. An auditor reconstructing the timeline later should confirm the hit ratio reflects the intended state before treating the step as complete. A reviewer checking the result afterwards is expected to verify the staleness bound independently rather than trusting a single reading.

Anyone continuing this work in a follow-up session needs to confirm that the origin store actually accepted the change and now reflects it. The person who signs off the operation is expected to verify the staleness bound independently rather than trusting a single reading. The on-call responder needs to confirm that the cache tier actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later is expected to verify the staleness bound independently rather than trusting a single reading.

The person who signs off the operation should prefer stopping over guessing whenever the cache tier returns an ambiguous response. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure should prefer stopping over guessing whenever the invalidation channel returns an ambiguous response. The change owner must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information.
