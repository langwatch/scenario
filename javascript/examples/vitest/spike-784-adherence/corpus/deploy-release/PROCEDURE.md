---
id: deploy-release
kind: procedure
keywords: [deploy, release, operation, recovery, audited]
links: [escalate-ticket, migrate-dataset, decommission-endpoint, audit-record]
status: active
---
# Deploy Release

## Purpose
This procedure describes how to roll a new version of release into production safely and reversibly. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.

## When this applies
- Use this when an alert indicates the target has degraded.
- Use this when a request from an owner has been approved.
- Use this when a dependency change forces a corresponding update here.
- Use this when a preceding procedure explicitly hands off to this one.
- Use this when a scheduled maintenance window requires it.

## Preconditions
- [ ] The change window is open and stakeholders have been informed.
- [ ] You have the authorization required for this operation.
- [ ] The relevant dashboards and alerts are visible to you for the duration.
- [ ] A recent backup or recovery point exists and has been verified as restorable.
- [ ] No conflicting operation is in progress against the same target.

## Inputs and outputs
This procedure reads and writes the following around release:
- The changelog
- The artifact bundle
- The version number
- The sign-off record

## Procedure
1. Stage the change behind a guard.
2. Promote release incrementally.
3. Watch the promotion gate during rollout.
4. Confirm the changelog matches the intended version.

## Verification
Confirm the promotion gate is within its expected bound and that the sign-off record reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of the distribution channel rather than a cached copy.

## Failure modes
- Watch for the case where the operation is retried and the second attempt collides with the first; if it occurs, stop and follow the rollback section.
- Watch for the case where an unrelated concurrent change touches the same target and the two interleave; if it occurs, stop and follow the rollback section.
- Watch for the case where the verification step passes against a cached reading rather than the live state; if it occurs, stop and follow the rollback section.
- Watch for the case where a permission was sufficient to begin but not to complete, stranding the operation midway; if it occurs, stop and follow the rollback section.
- Watch for the case where a downstream consumer is not ready and rejects the propagated change; if it occurs, stop and follow the rollback section.
- Watch for the case where a partial write completes and then the connection drops before acknowledgement; if it occurs, stop and follow the rollback section.

## Rollback and recovery
If the operation must be undone, restore the version number from the recovery point identified in the preconditions, reattach release to the distribution channel, and confirm the promotion gate returns to baseline. Never leave release in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.

## Escalation
If you cannot complete this procedure, or you observe impact beyond release, follow procedure `escalate-ticket` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.

## Related procedures
- `escalate-ticket`
- `migrate-dataset`
- `decommission-endpoint`
- `audit-record`

## Notes and edge cases
- Leave the system in a strictly better-understood state than you found it, even if you did not finish.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- A dry run against a non-production copy is cheap insurance for any irreversible step.
- When in doubt about scope, choose the narrower interpretation and confirm before widening it.
- Record who performed the operation and when, so the audit ledger stays trustworthy.
- Record who performed the operation and when, so the audit ledger stays trustworthy.

## Additional considerations
A reviewer checking the result afterwards should keep the blast radius small and the operation reversible at every point. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. An auditor reconstructing the timeline later should confirm the artifact bundle reflects the intended state before treating the step as complete. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. The operator running this procedure should keep the blast radius small and the operation reversible at every point.

The on-call responder needs to confirm that the release registry actually accepted the change and now reflects it. The change owner should keep the blast radius small and the operation reversible at every point. The on-call responder needs to confirm that the artifact store actually accepted the change and now reflects it. The operator running this procedure is expected to verify the promotion gate independently rather than trusting a single reading. The person who signs off the operation should confirm the version number reflects the intended state before treating the step as complete.

The person who signs off the operation should confirm the version number reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should confirm the artifact bundle reflects the intended state before treating the step as complete. A reviewer checking the result afterwards should prefer stopping over guessing whenever the distribution channel returns an ambiguous response. The person who signs off the operation is expected to verify the promotion gate independently rather than trusting a single reading. An auditor reconstructing the timeline later should leave a clear note for the next person about what remains and why.

Anyone continuing this work in a follow-up session is expected to verify the promotion gate independently rather than trusting a single reading. Anyone continuing this work in a follow-up session should leave a clear note for the next person about what remains and why. The on-call responder should leave a clear note for the next person about what remains and why. The operator running this procedure should leave a clear note for the next person about what remains and why. The on-call responder should confirm the artifact bundle reflects the intended state before treating the step as complete.

Anyone continuing this work in a follow-up session is expected to verify the promotion gate independently rather than trusting a single reading. Anyone continuing this work in a follow-up session must not disable a check to make progress, because a failing check is information. The person who signs off the operation is expected to verify the promotion gate independently rather than trusting a single reading. The person who signs off the operation must record what was observed against the operation id so the history stays reconstructable. An auditor reconstructing the timeline later needs to confirm that the distribution channel actually accepted the change and now reflects it.

The operator running this procedure should keep the blast radius small and the operation reversible at every point. Anyone continuing this work in a follow-up session is expected to verify the promotion gate independently rather than trusting a single reading. A reviewer checking the result afterwards should leave a clear note for the next person about what remains and why. The person who signs off the operation should prefer stopping over guessing whenever the release registry returns an ambiguous response. The on-call responder is expected to verify the promotion gate independently rather than trusting a single reading.
