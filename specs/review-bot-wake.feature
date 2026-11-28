Feature: Review bot wake
  As a pull request author
  I want the Laze PR review bot woken once the other checks on my head commit pass
  So that it reviews code that already builds and tests green, without anyone asking

  The review-bot-wake workflow waits for the head commit's check runs, check
  suites, commit statuses and workflow runs to finish, then posts one comment
  that mentions @langwatch-pr-review-bot; the bot's Laze watch turns that
  comment into a review. The wait and its verdict live in
  .github/scripts/review-bot-wake.ts. The workflow never gates a merge and is
  kept out of branch protection.

  Background:
    Given the review-bot-wake workflow runs on pull_request events
    And it judges the checks of the pull request's head commit

  Scenario Outline: Pull requests the bot does not review are skipped
    Given a pull request that <kind>
    When the workflow is triggered
    Then the wake job is skipped
    And no comment is posted
    And the workflow does not fail

    Examples:
      | kind                                   |
      | is a draft                             |
      | was opened by dependabot[bot]          |
      | was opened by renovate[bot]            |
      | comes from a forked repository         |

  Scenario: All checks green wakes the review bot with one comment
    Given every other check run, check suite and commit status on the head commit finished green
    When the wait reads the checks
    Then exactly one comment is posted on the pull request
    And it mentions @langwatch-pr-review-bot and names the head commit

  Scenario: A red check wakes nothing
    Given a check run on the head commit failed, was cancelled or timed out
    When the wait reads the checks
    Then the wait ends at once with a notice naming the check
    And no comment is posted

  @unit
  Scenario: A red commit status wakes nothing
    Given a commit status on the head commit is failure or error
    When the wait reads the checks
    Then the verdict is red and names the status context

  Scenario: A run cancelled by a newer run of its workflow is ignored
    Given a workflow ran twice on the head commit
    And the older run was cancelled by the newer run's concurrency group
    And the newer run finished green
    When the wait reads the checks
    Then only the run whose latest attempt started last is judged
    And the cancelled run does not keep the bot asleep

  @unit
  Scenario: Same-named jobs in different workflows are judged apart
    Given two workflows each have a job with the same name
    And only one of them failed
    When the wait reads the checks
    Then the verdict is red and names the failed job with its workflow
    And a re-run of a job within one workflow run supersedes its old run

  @unit
  Scenario: A suite still running is waited for
    Given a workflow run or check suite on the head commit is still queued or in progress
    When the wait reads the checks
    Then the verdict is pending, even when its finished jobs all passed
    And a check suite of an app that never reports a check run is left out

  @unit
  Scenario: The wake never waits on itself
    Given the wake job's own check run is in progress on the head commit
    When the wait reads the checks
    Then its own check run, check suite and workflow runs are left out

  @unit
  Scenario: An API error round is never green
    Given a read of the checks fails with a GitHub API error
    When the wait handles that round
    Then the round counts as unread and the wait tries again
    And it never counts as green

  Scenario: The 45-minute deadline wakes nothing
    Given the checks are still running or unreadable 45 minutes after the wait started
    When the deadline passes
    Then the wait ends with a notice
    And no comment is posted

  Scenario: A new push cancels the old wait
    Given a wake is waiting on the checks of the previous head commit
    When a new commit is pushed to the pull request
    Then the old wait is cancelled
    And only the new head commit can wake the bot

  Scenario: Any failure keeps the job green
    Given the checks are red or slow, the GitHub API errors, the classifier tests fail or the comment fails
    When the workflow finishes
    Then the wake job ends green
    And it never fails the pull request
