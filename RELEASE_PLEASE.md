# Release Please Implementation

This project uses [release-please](https://github.com/googleapis/release-please) to automate releases for the JavaScript and Python packages and the Go modules in our monorepo.

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

### Go modules (`go/`)

Every directory under `go/` with its own `go.mod`, except `go/examples`, is a
module that is published on its own. A Go module in a subdirectory is
published by a tag made of its directory plus the version, and `cmd/go`
accepts no other form, so each one is its own release-please component:

| Module | Directory | Tag Pattern |
| --- | --- | --- |
| `github.com/langwatch/scenario/go` | `go/` | `go/v{version}` |
| `github.com/langwatch/scenario/go/voice` | `go/voice/` | `go/voice/v{version}` |
| `github.com/langwatch/scenario/go/voice/tunnel/ngrok` | `go/voice/tunnel/ngrok/` | `go/voice/tunnel/ngrok/v{version}` |
| `github.com/langwatch/scenario/go/providers/openai` | `go/providers/openai/` | `go/providers/openai/v{version}` |
| `github.com/langwatch/scenario/go/providers/anthropic` | `go/providers/anthropic/` | `go/providers/anthropic/v{version}` |
| `github.com/langwatch/scenario/go/providers/gemini` | `go/providers/gemini/` | `go/providers/gemini/v{version}` |
| `github.com/langwatch/scenario/go/providers/bedrock` | `go/providers/bedrock/` | `go/providers/bedrock/v{version}` |

- **Release Type**: `go` (CHANGELOG.md in each module directory)
- **Versions**: linked. Every Go module releases at the same version, from the
  same commit, in one release PR (the `linked-versions` plugin, group
  `go-sdk`). See below for why.
- **Published by**: the tag itself. `go-publish.yml` runs once per tag; it does
  not upload anything, it checks the release and fetches it through
  `proxy.golang.org` so it is available at once.

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

## Go modules: versioning, local development and releases

### Why the Go modules share one version

The submodules depend on the root module, and `go/voice/tunnel/ngrok` depends
on `go/voice`. Each of those dependencies is a `require` line naming a version,
and that version has to exist as a tag when a consumer runs `go get`. The
alternative everyone reaches for first, `replace github.com/langwatch/scenario/go
=> ../`, does not work for consumers: `cmd/go` ignores replace directives in any
module but the one being built, so the consumer resolves whatever the `require`
line says, and `v0.0.0` never existed.

With linked versions, the version a submodule must require is always the
version being released, so release-please writes it. Every in-repo `require`
line, and every `replace` line in `go/go.work`, ends in
`// x-release-please-version`, and the release PR rewrites them together with
the changelogs. All tags then point at one commit, where every module requires
exactly the versions tagged next to it. A consumer can mix the modules only at
matching versions, which is also the only combination CI ever tested.

Independent versions would let a provider change ship without bumping voice,
but then nothing writes the `require` lines: every change to the root module
that a submodule needs would take two releases (root first, then a PR bumping
the submodule's `require`, then the submodule), and the go.mod files would have
to be edited by hand each time. The cost of linking is a release of modules
that did not change, with an empty changelog section. That is cheap in Go, where
a version only moves when the consumer asks for it.

### Local development: `go/go.work`

`go/go.work` lists every module under `go/` so they build against this checkout.
It also replaces each in-repo module at the version the go.mod files require
with its directory. That line matters: even for a module in the workspace,
`cmd/go` reads the `go.mod` of the required version while it builds the module
graph, so without it a version that is not tagged yet (in every release PR, and
before the first release) cannot be resolved.

- Run any `go` command anywhere under `go/` as usual; the workspace applies.
- `GOWORK=off` builds a module the way a consumer does, from tagged versions.
- `make go-fmt go-vet go-test go-tidy` run over every module, or over the ones
  in `GO_MODULES` (`make go-test GO_MODULES=go/voice`). `make go-check` runs
  everything `go-ci` runs.
- `make go-tidy` tidies with `GOWORK=off`, pointing the other in-repo modules
  at their directories only for the duration of the call. Use it instead of
  `go mod tidy`: the go.sum files deliberately hold no hashes for this
  repository's own modules (the workspace never needs them, and before a
  release they cannot exist), and the `tidy` job in `go-ci` fails on any
  difference.

Adding a module: create its `go.mod` under `go/`, add it to the `use` list in
`go/go.work` (the `workspace` job fails otherwise), add a package to
`.release-please-config.json` with `"extra-files": ["go.mod"]`, add its
component to the `go-sdk` group and its current version to
`.release-please-manifest.json`, and end each of its in-repo `require` lines
with `// x-release-please-version`. If other modules require it, add a
`replace <module> vX.Y.Z => ./<dir> // x-release-please-version` line to
`go/go.work`. `go-ci` picks it up on its own.

### Releasing the Go modules

1. release-please opens one draft release PR for the `go-sdk` group. It bumps
   every module's CHANGELOG.md and the manifest to the same version, and
   rewrites the annotated `require` lines in the submodules' go.mod files and
   the `replace` lines in `go/go.work` to that version.
2. Mark it ready for review. `go-ci` runs every module inside the workspace,
   which is why the not-yet-tagged version resolves.
3. Merge it. release-please creates one tag and GitHub release per module, all
   on the merge commit, one after another (`sequential-calls` is on, and the
   root module is listed first in the config).
4. `go-publish.yml` runs for each release: it builds, vets and tests the module
   at the tag, fetches `<module>@<version>` through `proxy.golang.org`, and then
   builds it as a dependency of a new, empty module from the proxy alone. Those
   last two steps retry for a few minutes, because a submodule's tag can be
   published seconds before the root tag it requires.

A Go tag must never be moved or deleted: `proxy.golang.org` and
`sum.golang.org` keep the first content they saw for a version, forever. To
undo a bad release, release a new patch version, and add a `retract` directive
for the bad one to that module's go.mod.

### First release (one time)

Until the first Go tag exists, every in-repo `require` line names `v0.1.0`,
which is not tagged (the manifest records 0.1.0 for the root module, but no
`go/v0.1.0` tag was ever pushed). The workspace resolves it locally, so
development and CI work; `GOWORK=off` builds of a submodule fail until the root
module is tagged. A pseudo-version of the parent commit cannot stand in before
merging: the commit only exists on the PR branch, and the squash merge replaces
it with a different one on `main`.

The sequence is the root module first, then the submodules that require it:

1. Merge the change that introduced this setup. release-please opens the
   `go-sdk` release PR at the next version (0.1.1 with the current pre-1.0 bump
   rules; set `"release-as"` on the Go packages to pick another, then remove it
   after the release).
2. Merge that PR. release-please tags `go/vX.Y.Z`, `go/voice/vX.Y.Z`, the
   providers and `go/voice/tunnel/ngrok/vX.Y.Z` on one commit within seconds of
   each other, and `go-publish` checks each one from the proxy, retrying while
   a tag it depends on is still being created.
3. Check from outside the repository:
   `GOWORK=off GOPROXY=https://proxy.golang.org go list -m github.com/langwatch/scenario/go/voice@vX.Y.Z`.

If release-please cannot do it (or the root module must ship before the
submodules are ready), the same order works by hand:

1. Tag the root module on `main` and push the tag:
   `git tag go/vX.Y.Z <commit> && git push origin go/vX.Y.Z`, then
   `GOPROXY=https://proxy.golang.org go list -m github.com/langwatch/scenario/go@vX.Y.Z`.
2. In a PR, set the submodules' annotated `require` lines and the `go/go.work`
   `replace` lines to `vX.Y.Z`, run `make go-tidy`, and merge.
3. Tag `go/voice/vX.Y.Z` and each `go/providers/<name>/vX.Y.Z` on that merge
   commit, then `go/voice/tunnel/ngrok/vX.Y.Z` (it requires voice), and push.
   Run `go-publish` by hand (workflow dispatch, with the tag) for each.
4. Set every Go entry in `.release-please-manifest.json` to `X.Y.Z` so the next
   release PR starts from there.

## Manual Release (if needed)

To force a release or fix issues:

1. Add `release-please:force-run` label to any merged PR
2. Or run the release-please GitHub Action manually

## Configuration Files

- `.release-please-config.json` - Main configuration
- `.release-please-manifest.json` - Current version tracking
- `.github/workflows/release-please.yml` - GitHub Action workflow
- `go/go.work` - Go workspace; its `replace` lines are bumped with each Go release

## Troubleshooting

- **No release PR created**: Ensure commits follow conventional format
- **Wrong version bump**: Check commit message types
- **Failed publish**: Check secrets (NPM_TOKEN, PYPI_API_TOKEN) are set
- **Go module not found by `go get`**: Check the tag is the module directory plus the version (`go/voice/v0.2.0`, not `voice/v0.2.0` or `go/voice-v0.2.0`), and re-run `go-publish` by hand with that tag
