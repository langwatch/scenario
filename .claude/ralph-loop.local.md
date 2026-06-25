---
active: true
iteration: 1
session_id: 143586e0-fb4b-4aed-a385-224c6d4c2ffd
max_iterations: 40
completion_promise: "705-PR-READY"
started_at: "2026-06-25T13:01:14Z"
---

drive #705 to a CLEAN FIX PR #707 per the DIRECTION UPDATE in /home/ubuntu/.claude/plans/2026-06-25-scenario-705-build-brief.md. STEP 0 (do FIRST, now): commit current WIP and PUSH fix/705-real-voice-multiturn to #707 so Drew can eyeball the actual diff (remote is still the stale 11:52 spike). SCOPE (Drew, narrowed): TS-ONLY. Python parity is OUT of this PR -> move python changes to a SEPARATE follow-up PR/branch. This PR = the minimal clean fix ONLY: drop the turnCommitMode public knob (real-audio is the default, no toggle) + the #493 receiveAudio bounded total-wait backstop + a focused proof test (the customer's exact setup via live CI). REMOVE the exploratory/redundant spike test scaffolding; keep infra the clean proof needs (e.g. provision script if CI uses it). DROP the 'spike' framing from the PR title/body. Commit per step; get javascript-voice-integration CI green; drive #707 to overall READY via /home/ubuntu/.claude/scripts/pr-ready-check.sh langwatch scenario 707. Do NOT merge (Rule 5). Output <promise>705-PR-READY</promise> ONLY when pr-ready-check shows overall READY; report status (clean-fix vs spike-shaped + what moved to the python PR) to the orchardist.
