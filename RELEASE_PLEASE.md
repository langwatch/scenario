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
2. **Merge to Main**: Release Please will create release PRs automatically
3. **Review Release PR**: Check the generated changelog and version bumps
4. **Merge Release PR**: This triggers the automated publishing workflows

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
