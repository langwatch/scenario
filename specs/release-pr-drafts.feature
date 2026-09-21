Feature: Release pull requests open as drafts
  As a maintainer of this repository
  I want release-please to open its release pull requests as drafts
  So that a version bump does not run the full test suite on every merge to main

  release-please creates-or-updates one release pull request per package. Every
  merge to main force-pushes those branches, and the diff is a changelog plus a
  version field in `package.json` or `pyproject.toml`. Both aggregator workflows
  path-filter on their own package directory, correctly, since a dependency bump
  touches the same files, and a path filter cannot tell a version bump from a
  dependency bump. So a two-file metadata change pulled the JavaScript suite,
  the Python suite and the examples legs, on every merge, for as long as the
  release pull request stayed open.

  The heavy jobs already skip a draft. Opening these pull requests as drafts
  therefore buys the reduction with no new mechanism, and the full suite still
  runs before anything ships: marking the pull request ready to review fires
  `ready_for_review`, which the aggregator workflows list in their trigger types
  precisely so the heavy jobs get their run then. A draft cannot be merged, so
  "ready for review" is the same click as "I am releasing this".

  Background:
    Given release-please is configured by `.release-please-config.json`
    And the aggregator workflows are `javascript-ci`, `python-ci` and `docs-ci`

  @unit
  Scenario: The release configuration opens release pull requests as drafts
    When the release-please configuration is read
    Then it sets draft-pull-request

  @unit
  Scenario: Every aggregator workflow skips its heavy job on a draft
    When each aggregator workflow's heavy job condition is read
    Then the condition requires the pull request not to be a draft
    And it requires it as a conjunct, so nothing else in the condition can
      run the heavy job on a draft anyway

  @unit
  Scenario: Every aggregator workflow runs when a draft is marked ready
    When each aggregator workflow's pull_request trigger is read
    Then its types include ready_for_review
    And its types still include opened, synchronize and reopened

  Scenario: A merge to main refreshes a release pull request without running the suite
    Given an open release pull request in draft
    When a commit lands on main and release-please updates that pull request
    Then the aggregator workflows report success with their heavy jobs skipped

  Scenario: Marking the release pull request ready runs the full suite
    Given an open release pull request in draft
    When a maintainer marks it ready for review
    Then the aggregator workflows run their heavy jobs against the release commit
