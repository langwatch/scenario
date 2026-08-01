Feature: The TypeScript lint gate covers every file it claims to, and debt cannot grow silently
  As a maintainer of the @langwatch/scenario TypeScript SDK
  I want CI to lint every file the workspace owns, with no package or path able to
  opt out by accident
  So that lint debt is visible when it is introduced instead of accumulating
  invisibly, and so a green lint run means what a reader assumes it means

  Background:
    Given the TypeScript SDK lives in javascript/ as a pnpm workspace
    And pnpm-workspace.yaml lists "." plus examples/*, examples/openai-realtime-demo and examples/openai-realtime-demo/realtime-client
    And `pnpm -r run <script>` excludes the workspace ROOT even though "." is listed in packages:
    And `pnpm -r run <script>` SKIPS, without erroring, any package that has no such script
    And the examples import @langwatch/scenario through its published exports map, which points at dist/
    And PR #755 added a lint:lib CI step that already gates src/ excluding tests
    And the measured baseline at 88aec40 (post `pnpm install --frozen-lockfile` + `pnpm build`, eslint 9.39.4) is
      | scope                                   | problems | gated before this change |
      | src/** non-test (shipped library)       | 0        | yes, by lint:lib         |
      | src/** tests                            | 209      | no                       |
      | root-level files (demo, scripts/)       | 2        | no                       |
      | examples/custom-observability           | 19       | no — it has no lint script |
      | other examples/*                        | 0        | yes, by lint:all         |

  # ============================================================
  # Group: The gate reaches every root-owned file (AC1, AC7)
  # ============================================================

  @integration
  Scenario: lint:root covers src tests, root-level files and scripts, and excludes examples
    # AC1
    Given the lint:root script is defined in javascript/package.json
    When `pnpm lint:root --format json` is run from javascript/
    Then the linted-file list includes at least one path under src/ that is not a test
    And it includes at least one path under src/**/__tests__/
    And it includes the repo-root file demo-sliding-deadline.ts
    And it includes at least one path under scripts/
    And it includes zero paths under examples/

  @integration
  Scenario Outline: each root-owned sub-scope actually fails the gate when defective
    # AC1 — one injected defect per sub-scope, proving the scope is gated and not merely listed
    Given the working tree is clean and `pnpm lint:root` exits 0
    When <defect> is injected into <file>
    Then `pnpm lint:root` exits non-zero
    And reverting the injection returns `pnpm lint:root` to exit 0

    Examples:
      | file                                     | defect                            |
      | src/agents/__tests__/red-team.test.ts    | an out-of-order import            |
      | demo-sliding-deadline.ts                 | an unused top-level variable      |
      | scripts/generate-noise-samples.mjs       | a reference to an undefined global |

  @integration
  Scenario: scripts/ is linted with Node globals rather than browser globals
    # AC7
    Given scripts/generate-noise-samples.mjs is a Node script that uses Buffer
    And eslint.config.mjs previously applied globals.node only to *.config.* files
    When `pnpm lint:root` is run
    Then scripts/generate-noise-samples.mjs reports zero problems
    And no inline eslint-disable comment was added to that file to achieve it

  # ============================================================
  # Group: The autofixable debt is cleared by fixing code, not by silencing rules (AC2, AC11)
  # ============================================================

  @integration
  Scenario: import/order is clean across the newly gated surface
    # AC2
    Given the baseline carried 98 import/order problems in src/** tests and 1 in demo-sliding-deadline.ts
    When `pnpm lint:root --format json` is run on the change
    Then zero messages carry ruleId "import/order"
    And the one violation that `--fix` could not resolve, in src/voice/__tests__/playback.test.ts,
        was fixed by moving the import rather than by suppressing the rule

  @integration
  Scenario: the baseline was cleared by fixing code, not by disabling rules or widening ignores
    # AC11 — the escape hatch every bare "reports 0 problems" criterion leaves open
    When the diff of javascript/eslint.config.mjs against main is inspected
    Then no rule severity moved from "error" to "warn" or "off"
    And no new entry was added to the top-level ignores array
    But the no-explicit-any warn block scoped to src/**/*.test.ts and src/**/__tests__/** is permitted, per AC3
    And the count of files linted by lint:root is greater than or equal to the count on main
    And no added line in the diff introduces eslint-disable, --quiet, continue-on-error or no-error-on-unmatched-pattern

  # ============================================================
  # Group: no-explicit-any is enforced where it ships and ratcheted where it does not (AC3)
  # ============================================================

  @integration
  Scenario: a new any in shipped library source fails the gate
    # AC3
    Given src/** non-test currently reports zero no-explicit-any problems
    When an `any` is added to a non-test file under src/
    Then `pnpm lint:root` exits non-zero
    And `pnpm lint:lib` exits non-zero

  @integration
  Scenario: the existing test-file any is tolerated but cannot grow
    # AC3 — the ratchet; without it "warn" would let 106 become 300 silently
    Given src/** tests carry exactly 106 no-explicit-any warnings
    And lint:root runs with --max-warnings=106
    When `pnpm lint:root` is run unmodified
    Then it exits 0
    But when a 107th `any` is added to src/agents/__tests__/red-team.test.ts
    Then `pnpm lint:root` exits non-zero

  # ============================================================
  # Group: no package can escape the gate (AC5, AC6)
  # ============================================================

  @integration
  Scenario: a workspace package with no lint script fails the gate instead of being skipped
    # AC5 — the silent-skip hole that hid 19 problems
    Given the guard enumerates workspace packages at runtime via `pnpm list -r --depth -1 --json`
    And it never reads a hardcoded package list
    When the lint script is removed from an existing package's package.json
    Then `pnpm lint:all` exits non-zero naming that package
    And when a NEW workspace package containing no lint script is added instead
    Then `pnpm lint:all` exits non-zero naming that package
    And restoring both returns `pnpm lint:all` to exit 0

  @integration
  Scenario: an enumerated lint script fails the gate because it drifts
    # AC5 — `eslint agents/ index.ts` lints only what someone remembered that day
    Given a package's lint script is changed from `eslint .` to an enumerated file list
    When `pnpm lint:all` is run
    Then it exits non-zero naming that package and its enumerated command

  @integration
  Scenario: examples/custom-observability is gated and clean without gutting its probes
    # AC6 — nothing in CI executes this package, so the cleanup must be proven by running it
    Given the package previously had no lint script and 19 problems
    When it gains `"lint": "eslint ."` and the problems are fixed
    Then `pnpm -F custom-observability-example lint` exits 0 with zero messages
    And `pnpm -F custom-observability-example test:all` exits 0
    And test-no-auto-init.ts still performs `await import("@langwatch/scenario")` for its side effect
    And that probe still prints "Importing @langwatch/scenario did NOT auto-initialize OpenTelemetry"

  # ============================================================
  # Group: the gate fails honestly, not confusingly (AC4)
  # ============================================================

  @integration
  Scenario: linting without a build reports the real cause instead of 63 resolver errors
    # AC4 — reframed: the dist/ dependency is legitimate (examples consume the published
    # surface); what was broken is that its absence produced misleading output
    Given javascript/dist has been removed
    When `pnpm lint:all` is run
    Then it exits non-zero
    And the output names javascript/dist as missing and tells the reader to run `pnpm build`
    And it does not emit 63 import/no-unresolved errors for '@langwatch/scenario'

  # ============================================================
  # Group: nothing that already worked regressed (AC8, AC9, AC10)
  # ============================================================

  @integration
  Scenario: lint:lib and lint:all still cover at least what they covered before
    # AC8 — exit 0 alone would also pass for a gutted script
    When the linted-file sets of lint:lib and lint:all are compared against main
    Then each after-set is a superset of its before-set
    And both commands exit 0

  @integration
  Scenario: the import reorder changed no runtime behaviour
    # AC10 — a differential, not merely "green"
    Given the autofix reordered imports across 40+ files under src/
    When `pnpm test` is run before and after the change
    Then both runs report 92 test files passed and 1079 tests passed with 4 skipped
    And `pnpm typecheck:all` exits 0

  @integration
  Scenario: the gate is green on a CI run that actually executed it
    # AC9 — a draft PR yields a green javascript-ci with ci-checks SKIPPED, so the
    # job's own conclusion is what counts, never the aggregate
    Given the PR is not a draft
    When javascript-ci runs on it
    Then the ci-checks job's own conclusion is "success" and not "skipped"
    And the "Lint (root package)", "Lint (library)" and "Lint (workspace packages)" steps all pass
    And no --max-warnings other than the AC3 ratchet, and no --quiet or continue-on-error, was added
