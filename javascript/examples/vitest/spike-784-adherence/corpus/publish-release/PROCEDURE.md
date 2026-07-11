---
id: publish-release
kind: procedure
keywords: [publish, release, safety, reversible, recovery]
links: [escalate-ticket, validate-credential, reconfigure-service, validate-cache]
status: active
---
# Publish Release

## Purpose
This procedure describes how to make release available to its consumers under change control. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a scheduled maintenance window requires it.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when an alert indicates the target has degraded.
- Use this when a request from an owner has been approved.
- Use this when a periodic policy requires the operation on a cadence.

## Preconditions
- [ ] The change window is open and stakeholders have been informed.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] No conflicting operation is in progress against the same target.
- [ ] You have the authorization required for this operation.
- [ ] The rollback path has been identified and is known to work.

## Inputs and outputs
This procedure reads and writes the following around release:
- The changelog
- The artifact bundle
- The version number
- The sign-off record

## Procedure
1. Finalize release.
2. Promote the artifact bundle through the release registry.
3. Confirm the promotion gate.
4. Announce availability.

## Verification
Confirm the promotion gate is within its expected bound and that the artifact bundle reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the release registry rather than a cached copy.

## Failure modes
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the rollback path itself depends on the thing being changed and is unavailable when needed; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the artifact bundle from the recovery point identified in the preconditions, reattach release to the release registry, and confirm the promotion gate returns to baseline. Never leave release in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond release, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `validate-credential`
- `reconfigure-service`
- `validate-cache`

## Notes and edge cases
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Never disable a safety check to make a step pass; a red check is information, not an obstacle.
- Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.

## Additional considerations
The change owner must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session needs to confirm that the release registry actually accepted the change and now reflects it. An auditor reconstructing the timeline later should confirm the artifact bundle reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session must record what was observed against the operation id so the history stays reconstructable. The change owner is expected to verify the promotion gate independently rather than trusting a single reading.

The operator running this procedure must not disable a check to make progress, because a failing check is information. The person who signs off the operation should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later is expected to verify the promotion gate independently rather than trusting a single reading. An auditor reconstructing the timeline later must record what was observed against the operation id so the history stays reconstructable. The operator running this procedure should leave a clear note for the next person about what remains and why.

An auditor reconstructing the timeline later is expected to verify the promotion gate independently rather than trusting a single reading. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The on-call responder must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later needs to confirm that the distribution channel actually accepted the change and now reflects it. The on-call responder needs to confirm that the distribution channel actually accepted the change and now reflects it.

The person who signs off the operation is expected to verify the promotion gate independently rather than trusting a single reading. The person who signs off the operation should leave a clear note for the next person about what remains and why. The person who signs off the operation should prefer stopping over guessing whenever the release registry returns an ambiguous response. Anyone continuing this work in a follow-up session is expected to verify the promotion gate independently rather than trusting a single reading. The change owner needs to confirm that the release registry actually accepted the change and now reflects it.

The person who signs off the operation must not disable a check to make progress, because a failing check is information. The change owner needs to confirm that the distribution channel actually accepted the change and now reflects it. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The change owner must not disable a check to make progress, because a failing check is information. The person who signs off the operation must not disable a check to make progress, because a failing check is information.

The person who signs off the operation should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later should prefer stopping over guessing whenever the artifact store returns an ambiguous response. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The on-call responder should prefer stopping over guessing whenever the artifact store returns an ambiguous response.
