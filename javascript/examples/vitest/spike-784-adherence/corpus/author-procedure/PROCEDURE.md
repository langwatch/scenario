---
id: author-procedure
kind: procedure
keywords: [author, procedure, adopt, meta, runbook, status, active]
links: [publish-policy, review-policy, escalate-ticket]
status: active
---
# Author and Adopt a New Procedure

## Purpose
This meta-procedure describes how to write a new procedure and adopt it into the corpus so that future operators follow it automatically. Use it whenever a repeated operation lacks a written procedure, or when a gap is discovered during an incident.

## When this applies
- Use this when the same operation has been performed ad hoc more than once.
- Use this when a review or incident identifies a missing or unclear procedure.
- Use this when an existing procedure must be superseded by a corrected one.

## Preconditions
- [ ] The operation is well enough understood to write down repeatable steps.
- [ ] A neutral, unambiguous id has been chosen (verb-object, lowercase).
- [ ] The intended links to related procedures are known.

## Procedure
1. Create a new file at `corpus/<id>/PROCEDURE.md`.
2. Add frontmatter with `id`, `kind: procedure`, `keywords`, `links`, and `status: draft`.
3. Write the body: Purpose, When this applies, Preconditions, Procedure, Verification, Rollback and recovery, Escalation, Related procedures.
4. Keep every step concrete and reversible; each step should map to an observable action.
5. Link the new procedure from any procedure that should hand off to it, and add its id to their `links`.
6. Once reviewed, change `status: draft` to `status: active` so it becomes binding.
7. Announce the new procedure so operators know to follow it.

## Verification
Confirm the new file parses (valid frontmatter), its `links` resolve to existing ids, and its `status` is `active`. A fresh operator, given only the corpus, should be able to follow it without further explanation.

## Rollback and recovery
If a newly adopted procedure proves wrong, set its `status` to `deprecated`, restore the previous guidance, and follow `review-policy` to decide the corrected form.

## Escalation
If there is disagreement about whether a procedure should be adopted, follow `escalate-ticket` to route the decision.

## Related procedures
- `publish-policy`
- `review-policy`
- `escalate-ticket`
