---
id: format
kind: procedure
keywords: [format, normalize, shape, artifact, output, meta, always]
links: [done, publish-report, escalate-ticket]
status: active
always_enforced: true
---
# Normalize the Produced Artifact Before Finishing

## Purpose
This meta-procedure describes how to bring the artifact a task produces into the shape the task requires before the task is finished. It exists so the output is consumable by the next operator every time, regardless of who produced it, and so a downstream reader never has to reshape it by hand. It is always in force: it governs every produced artifact, not only the requests that name it.

## When this applies
- Use this before finishing any task that produces an artifact for another reader or system.
- Use this whenever the required shape of the output is specified or implied by the request.
- Use this when an artifact will be handed off, published, or consumed downstream.

## Procedure
1. Determine the shape the produced artifact is required to take.
2. Compare the produced artifact against that required shape and mark every deviation.
3. Normalize the artifact to match the required shape, correcting each deviation.

## Verification
Confirm the produced artifact matches the required shape with no remaining deviation, and that a downstream reader can consume it without reshaping it first.

## Failure modes
- Watch for the case where the content is correct but the shape is wrong, so the next step cannot parse it; if it occurs, normalize before finishing.
- Watch for the case where a required field or section is left out of the artifact; if it occurs, add it before treating the task as done.

## Related procedures
- `done`
- `publish-report`
- `escalate-ticket`
