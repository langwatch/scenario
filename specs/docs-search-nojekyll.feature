Feature: Deployed docs search and assets survive GitHub Pages' Jekyll
  As a developer using the published Scenario docs
  I want the search box to return results and the heading/external-link icons to render
  So that I can find pages without the search silently failing
  And so the deploy serves the vocs `.vocs/` directory verbatim instead of
  letting GitHub Pages' default Jekyll strip it because its name starts with a dot

  Background:
    Given the Scenario docs are a vocs site under docs/ that builds to docs/docs/dist/
    And vocs emits the search index and icons under the dot-directory docs/docs/dist/.vocs/
    And the built index.html references /.vocs/icons/*.svg and the JS fetches /.vocs/search-index-<hash>.json root-absolute
    And .github/workflows/deploy-docs.yml uploads ./docs/docs/dist to GitHub Pages
    And GitHub Pages runs Jekyll by default, which excludes any path whose name begins with a dot
    And vocs copies docs/docs/public/ verbatim into the artifact root (favicon.ico and images/ ship this way today)
    And the canonical host is https://scenario-docs.langwatch.ai and langwatch.ai/scenario is a proxy of it

  # ============================================================
  # Group: The fix lands in the build artifact (PR-gating, provable pre-merge)
  # ============================================================

  @integration
  Scenario: The built Pages artifact contains a .nojekyll marker at its root
    # AC1, AC9 (PR-gating proof)
    Given a .nojekyll marker is added to the deployed Pages artifact root
    When the docs are built with `pnpm run build` from docs/
    Then a file named exactly ".nojekyll" exists at docs/docs/dist/.nojekyll (artifact root, not nested)
    And `test -f docs/dist/.nojekyll` from docs/ exits 0

  @integration
  Scenario: The .nojekyll source is tracked in git, not an ephemeral untracked step
    # AC2
    Given the fix uses the committed-file shape
    When the working tree is inspected
    Then `git ls-files docs/docs/public/.nojekyll` prints the path
    And vocs copies it into docs/docs/dist/.nojekyll on the next build
    But if instead the CI-step shape is used, `git show HEAD:.github/workflows/deploy-docs.yml` contains a net-new line referencing docs/docs/dist/.nojekyll
    And the mere pre-existing presence of the workflow file does not satisfy the criterion

  @integration
  Scenario: A clean rebuild still produces the marker
    # AC8
    Given the docs/dist output is deleted
    When `pnpm run build` is run again from docs/
    Then docs/docs/dist/.nojekyll exists again
    And a `clean` script does not leave the artifact without the marker

  # ============================================================
  # Group: The deployed site serves the dot-directory (post-deploy, live host)
  # ============================================================

  @e2e
  Scenario: The search index is served as JSON on the live site
    # AC3 (primary failure mode resolved)
    Given the Publish Docs workflow has deployed the fixed artifact to scenario-docs.langwatch.ai
    And the current search-index filename is discovered from the live page rather than hardcoded
    When `curl -sI` requests https://scenario-docs.langwatch.ai/.vocs/search-index-<hash>.json
    Then the response is HTTP 200 with a content-type containing application/json
    And it is no longer a 404 returning text/html

  @e2e
  Scenario: The search box returns results with no JSON-parse error
    # AC4 (user-visible behavior)
    Given the fixed docs are live
    When a user types a known term such as "judge" into the search box
    Then the search panel shows at least one matching result
    And the browser console shows no "SyntaxError: Unexpected token '<'" during the search

  @integration
  Scenario: The heading-anchor and external-link icons resolve
    # AC5 (sibling failure mode — icons)
    Given the fixed docs are live
    When `curl -sI` requests /.vocs/icons/link.svg and /.vocs/icons/arrow-diagonal.svg on the canonical host
    Then each returns HTTP 200 with a content-type containing image/svg+xml
    And neither returns 404

  @integration
  Scenario: Previously-working non-dot assets still serve
    # AC6 (regression surface)
    Given the fixed docs are live
    And the current CSS asset path is discovered from the live page rather than hardcoded
    When `curl -sI` requests the /assets/style-<hash>.css path
    Then it still returns HTTP 200 with a content-type containing text/css
    And the .nojekyll change has not regressed normal asset serving

  @e2e
  Scenario: The langwatch.ai/scenario proxy reflects the fix without a separate change
    # AC7 (proxy ripple)
    Given the canonical host scenario-docs.langwatch.ai is fixed
    When `curl -sI` requests https://langwatch.ai/.vocs/search-index-<hash>.json via the proxy
    Then it returns HTTP 200 with a content-type containing application/json
    And no apex/proxy configuration change was required

  # --- AC Coverage Map ---
  # AC 1: ".nojekyll present at deployed artifact root after build" → Scenario: The built Pages artifact contains a .nojekyll marker at its root
  # AC 2: ".nojekyll source is tracked in git (committed-file OR net-new CI step)" → Scenario: The .nojekyll source is tracked in git, not an ephemeral untracked step
  # AC 3: "search index served as application/json, not HTML fallback" → Scenario: The search index is served as JSON on the live site
  # AC 4: "search box returns results, no JSON-parse error" → Scenario: The search box returns results with no JSON-parse error
  # AC 5: "both .vocs icons return 200 image/svg+xml" → Scenario: The heading-anchor and external-link icons resolve
  # AC 6: "normal CSS asset still 200 text/css (regression)" → Scenario: Previously-working non-dot assets still serve
  # AC 7: "langwatch.ai proxy reflects fix, no separate change" → Scenario: The langwatch.ai/scenario proxy reflects the fix without a separate change
  # AC 8: "clean rebuild still contains .nojekyll" → Scenario: A clean rebuild still produces the marker
  # AC 9: "pre-merge artifact proof gates PR; live ACs are post-deploy" → Scenario: The built Pages artifact contains a .nojekyll marker at its root (PR-gating clause)
