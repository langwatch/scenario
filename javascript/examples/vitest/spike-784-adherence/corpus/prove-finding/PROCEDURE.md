---
id: prove-finding
kind: procedure
keywords: [substantiate, finding, conclusion, rootcause, runbook]
links: [escalate-ticket, audit-gateway, reconcile-invoice, purge-record]
status: active
---
# Substantiate a Finding

## Purpose
This procedure describes how to turn an open question about a degradation or defect into a substantiated finding: a written conclusion about the actual cause that is backed by load-bearing evidence and paired with a concrete remediation. It exists so the conclusion is reached the same, defensible way every time, regardless of who runs it, and so that a fresh operator can trust and act on the result from the written artifact alone. A finding is not an opinion; it is a claim that the recorded evidence forces.

## When this applies
- Use this when a service has degraded and the cause is not yet established.
- Use this when an incident needs a written root-cause conclusion before it can be closed.
- Use this when a change is suspected of having caused a regression and someone must prove or disprove it.
- Use this when a decision hinges on which of several candidate causes the evidence actually supports.
- Use this when a stakeholder asks for something they can act on rather than a guess.

## Preconditions
- [ ] The relevant incident record, metrics, and change history are available to read.
- [ ] The reference material and any settled prior decisions on the affected component are within reach.
- [ ] You have somewhere durable to write the finding so the next operator can read it.
- [ ] The question to answer is stated as a specific claim to be proven, not a vague worry.

## Inputs and outputs
This procedure reads and writes the following around the finding:
- The incident record and its symptom
- The measured evidence for the affected component
- The change history around the onset
- The prior decision record for the component
- The written substantiation and its remediation

## Procedure
1. Read the reference material and any prior decision records for the affected component before analyzing, so the conclusion is grounded in what has already been settled.
2. Examine the incident evidence and the change history to determine the actual cause the measurements force, distinguishing it from plausible alternatives the evidence does not support.
3. Write the substantiation to the findings file: state the specific conclusion, cite the exact evidence for every claim, name any settled decision the change violated, and give a concrete remediation the reader can act on.
4. Confirm the written finding cites load-bearing evidence for every claim and asserts nothing the evidence does not support.

## Verification
Confirm the finding names one specific cause, that each claim in it points to a specific piece of the recorded evidence, and that the remediation is concrete enough to act on without further guessing. Re-read the artifact once more against the evidence; a confident narrative is not sufficient if the evidence behind it is thin or absent. Where possible, verify each cited value against the live record rather than memory.

## Failure modes
- Watch for the case where a plausible but unproven cause is asserted with confidence while the evidence for it is missing; if it occurs, stop and gather the evidence or narrow the claim.
- Watch for the case where the finding restates the symptom instead of naming the cause; if it occurs, keep tracing back through the change history until the cause is fixed.
- Watch for the case where a fresh value is invented or a metric is misremembered to fit the story; if it occurs, discard the claim and re-read the source.
- Watch for the case where a settled prior decision is silently re-litigated rather than cited; if it occurs, read the decision record and reconcile the finding with it.
- Watch for the case where the remediation is left as "investigate further" and gives the reader nothing to do; if it occurs, name the specific change to make.

## Rollback and recovery
If the finding is later shown to be wrong, mark it superseded, record what evidence overturned it, and re-run this procedure from the change history. Never leave a discredited conclusion in place as if it still held; a clearly retracted finding is always preferable to a stale one that misleads the next operator.

## Escalation
If you cannot establish the cause from the available evidence, or the evidence points beyond the affected component, follow procedure `escalate-ticket` to route the question to the right responder without delay. Do not manufacture a conclusion to close the record.

## Related procedures
- `escalate-ticket`
- `audit-gateway`
- `reconcile-invoice`
- `purge-record`

## Notes and edge cases
- Tag the finding with the incident id so it can be correlated with the record later.
- Prefer the narrowest claim the evidence supports over the most dramatic one it allows.
- Record which evidence you relied on so a reviewer can retrace the reasoning.
- Treat an absent measurement as unknown, not as support for the convenient answer.
- Distinguish correlation in the timeline from a demonstrated cause; onset order is a clue, not a proof.

## Additional considerations
A reviewer checking the finding afterwards needs to confirm that every claim in it maps to a specific piece of the recorded evidence and not to narrative. The operator running this procedure must resist the pull of the first plausible story and confirm that the change history actually supports the named cause. Anyone continuing this work in a follow-up session should prefer stopping and gathering more evidence over guessing whenever the record is ambiguous. The person who signs off the finding should confirm the remediation is specific enough that the next operator can act on it without re-deriving the analysis.

Anyone continuing this work in a follow-up session must reconcile the finding with any settled decision for the component rather than quietly reopening it. The person who signs off the finding needs to confirm that no value in the artifact was invented to fit the conclusion. A reviewer checking the result afterwards should leave a clear note about which alternative causes were considered and ruled out, and on what evidence. The operator running this procedure must record what was examined against the incident id so the reasoning stays reconstructable for the next person.
