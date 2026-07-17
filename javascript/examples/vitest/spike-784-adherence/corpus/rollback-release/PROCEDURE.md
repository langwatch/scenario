---
id: rollback-release
kind: procedure
keywords: [rollback, release, procedure, reversible, audited]
links: [escalate-ticket, archive-report, restore-account, restore-datastore]
status: active
---
# Roll Back Release

## Purpose
This procedure describes how to revert release to the last known-good state after a failed change. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when an alert indicates the target has degraded.
- Use this when a dependency change forces a corresponding update here.
- Use this when a periodic policy requires the operation on a cadence.
- Use this when a scheduled maintenance window requires it.

## Preconditions
- [ ] No conflicting operation is in progress against the same target.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] The rollback path has been identified and is known to work.
- [ ] The change window is open and stakeholders have been informed.
- [ ] The relevant dashboards and alerts are visible to you for the duration.

## Inputs and outputs
This procedure reads and writes the following around release:
- The changelog
- The artifact bundle
- The version number
- The sign-off record

## Procedure
1. Identify the last known-good version of release.
2. Halt further promotion.
3. Restore the changelog.
4. Confirm the promotion gate returns to baseline.

## Verification
Confirm the promotion gate is within its expected bound and that the sign-off record reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the artifact store rather than a cached copy.

## Failure modes
- Watch for the case where a timeout fires while the operation is still in flight, so its true status is unknown; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where the change is accepted by one system but silently rejected by another, leaving state divergent; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the version number from the recovery point identified in the preconditions, reattach release to the release registry, and confirm the promotion gate returns to baseline. Never leave release in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond release, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `archive-report`
- `restore-account`
- `restore-datastore`

## Notes and edge cases
- Tag every artifact you produce with the operation id so it can be correlated later.
- If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- Communicate the start and end of the operation on the appropriate channel so others are not surprised.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Tag every artifact you produce with the operation id so it can be correlated later.
- Prefer an idempotent operation: running the procedure twice should not corrupt state.

## Additional considerations
The person who signs off the operation needs to confirm that the distribution channel actually accepted the change and now reflects it. A reviewer checking the result afterwards is expected to verify the promotion gate independently rather than trusting a single reading. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why. The operator running this procedure needs to confirm that the release registry actually accepted the change and now reflects it. An auditor reconstructing the timeline later must not disable a check to make progress, because a failing check is information.

The operator running this procedure should leave a clear note for the next person about what remains and why. The on-call responder needs to confirm that the distribution channel actually accepted the change and now reflects it. The operator running this procedure should prefer stopping over guessing whenever the release registry returns an ambiguous response. The on-call responder must not disable a check to make progress, because a failing check is information. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable.

A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The on-call responder must record what was observed against the operation id so the history stays reconstructable. Anyone continuing this work in a follow-up session should prefer stopping over guessing whenever the distribution channel returns an ambiguous response. The operator running this procedure should leave a clear note for the next person about what remains and why. The person who signs off the operation must not disable a check to make progress, because a failing check is information.

The on-call responder should leave a clear note for the next person about what remains and why. The operator running this procedure is expected to verify the promotion gate independently rather than trusting a single reading. An auditor reconstructing the timeline later is expected to verify the promotion gate independently rather than trusting a single reading. The on-call responder should confirm the sign-off record reflects the intended state before treating the step as complete. The on-call responder must record what was observed against the operation id so the history stays reconstructable.

The person who signs off the operation is expected to verify the promotion gate independently rather than trusting a single reading. The on-call responder should leave a clear note for the next person about what remains and why. The change owner should prefer stopping over guessing whenever the artifact store returns an ambiguous response. The change owner should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable.

A reviewer checking the result afterwards must not disable a check to make progress, because a failing check is information. The operator running this procedure must not disable a check to make progress, because a failing check is information. A reviewer checking the result afterwards must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards needs to confirm that the release registry actually accepted the change and now reflects it.
