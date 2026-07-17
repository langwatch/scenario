---
id: review-release
kind: procedure
keywords: [review, release, runbook, operation, reversible]
links: [escalate-ticket, rollback-service, publish-release, rollback-schema]
status: active
---
# Review Release

## Purpose
This procedure describes how to evaluate release and record an explicit decision. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when an alert indicates the target has degraded.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a dependency change forces a corresponding update here.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a request from an owner has been approved.

## Preconditions
- [ ] No conflicting operation is in progress against the same target.
- [ ] The change window is open and stakeholders have been informed.
- [ ] The rollback path has been identified and is known to work.
- [ ] You have the authorization required for this operation.
- [ ] A recent backup or recovery point exists and has been verified as restorable.

## Inputs and outputs
This procedure reads and writes the following around release:
- The changelog
- The artifact bundle
- The version number
- The sign-off record

## Procedure
1. Collect release and its context from the distribution channel.
2. Assess it against the artifact bundle.
3. Record the decision.
4. Confirm the promotion gate.

## Verification
Confirm the promotion gate is within its expected bound and that the version number reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the artifact store rather than a cached copy.

## Failure modes
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where a stale cache continues to serve the previous value after the change is applied; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the changelog from the recovery point identified in the preconditions, reattach release to the distribution channel, and confirm the promotion gate returns to baseline. Never leave release in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond release, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `rollback-service`
- `publish-release`
- `rollback-schema`

## Notes and edge cases
- Tag every artifact you produce with the operation id so it can be correlated later.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.

## Additional considerations
Anyone continuing this work in a follow-up session is expected to verify the promotion gate independently rather than trusting a single reading. A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. The change owner should prefer stopping over guessing whenever the release registry returns an ambiguous response. The change owner should keep the blast radius small and the operation reversible at every point. The operator running this procedure should prefer stopping over guessing whenever the artifact store returns an ambiguous response.

The on-call responder should keep the blast radius small and the operation reversible at every point. The on-call responder should confirm the changelog reflects the intended state before treating the step as complete. A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The on-call responder is expected to verify the promotion gate independently rather than trusting a single reading. The person who signs off the operation should confirm the sign-off record reflects the intended state before treating the step as complete.

The operator running this procedure needs to confirm that the distribution channel actually accepted the change and now reflects it. The person who signs off the operation should leave a clear note for the next person about what remains and why. The on-call responder should prefer stopping over guessing whenever the distribution channel returns an ambiguous response. The person who signs off the operation needs to confirm that the distribution channel actually accepted the change and now reflects it. The on-call responder should leave a clear note for the next person about what remains and why.

The on-call responder is expected to verify the promotion gate independently rather than trusting a single reading. The change owner should leave a clear note for the next person about what remains and why. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The change owner must record what was observed against the operation id so the history stays reconstructable. The person who signs off the operation should confirm the version number reflects the intended state before treating the step as complete.

The operator running this procedure must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The on-call responder is expected to verify the promotion gate independently rather than trusting a single reading. The on-call responder should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later is expected to verify the promotion gate independently rather than trusting a single reading.

The on-call responder must not disable a check to make progress, because a failing check is information. An auditor reconstructing the timeline later needs to confirm that the release registry actually accepted the change and now reflects it. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should keep the blast radius small and the operation reversible at every point. The on-call responder should leave a clear note for the next person about what remains and why.
