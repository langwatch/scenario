# Release Please Implementation

This project uses [release-please](https://github.com/googleapis/release-please) to automate releases for both JavaScript and Python packages in our monorepo.

## How It Works

1. **Conventional Commits**: All commits must follow the [Conventional Commits](https://www.conventionalcommits.org/) specification
2. **Automatic PRs**: Release Please creates release PRs when it detects releasable changes
3. **Automated Publishing**: When release PRs are merged, packages are automatically published

## Commit Message Format

```
type(scope): description

[optional body]

[optional footer]
```

### Release Types

- `feat:` - New feature (minor version bump)
- `fix:` - Bug fix (patch version bump)
- `feat!:` or `fix!:` - Breaking change (major version bump)
- `chore:`, `docs:`, `refactor:` - Non-breaking changes that will be included in releases

## Package Configuration

### JavaScript Package (`javascript/`)

- **Package**: `@langwatch/scenario`
- **Release Type**: `node`
- **Tag Pattern**: `javascript/v{version}`

### Python Package (`python/`)

- **Package**: `langwatch-scenario`
- **Release Type**: `python`
- **Tag Pattern**: `python/v{version}`

## Release Process

1. **Make Changes**: Create PRs with conventional commit messages
2. **Merge to Main**: Release Please will create release PRs automatically, as drafts
3. **Review Release PR**: Check the generated changelog and version bumps
4. **Mark it Ready for Review**: This runs the full test suite against the release commit
5. **Merge Release PR**: This triggers the automated publishing workflows

### Why the release PRs are drafts

Release Please updates its release PRs on every merge to `main`, and the
aggregator workflows path-filter on the package directory the version bump
lands in. Without the draft, a changelog and a version field ran the JavaScript
suite, the Python suite and the examples legs on every merge, for as long as the
release PR stayed open.

The heavy jobs of `javascript-ci`, `python-ci` and `docs-ci` skip a draft, and
they list `ready_for_review` in their trigger types, so marking the release PR
ready runs the full suite before anything ships. A draft cannot be merged, so
marking it ready is the same click as deciding to release. The setting is
`draft-pull-request` in `.release-please-config.json`, and
`scripts/validate-aggregator-workflows.sh` fails if it or either half of the
gate is removed. Spec: `specs/release-pr-drafts.feature`.

## Manual Release (if needed)

To force a release or fix issues:

1. Add `release-please:force-run` label to any merged PR
2. Or run the release-please GitHub Action manually

## Configuration Files

- `.release-please-config.json` - Main configuration
- `.release-please-manifest.json` - Current version tracking
- `.github/workflows/release-please.yml` - GitHub Action workflow

## Troubleshooting

- **No release PR created**: Ensure commits follow conventional format
- **Wrong version bump**: Check commit message types
- **Failed publish**: Check secrets (NPM_TOKEN, PYPI_API_TOKEN) are set
