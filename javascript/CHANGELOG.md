# Changelog

## [0.2.11](https://github.com/langwatch/scenario/compare/javascript/v0.2.10...javascript/v0.2.11) (2025-08-01)


### Bug Fixes

* remove stringify dependency, it's not used and brings a vulnerability ([9038119](https://github.com/langwatch/scenario/commit/9038119ed9142fb078e8ced80b4d9e3fd86a4ed8))
* update lockfile ([37f92bc](https://github.com/langwatch/scenario/commit/37f92bc5fee9cf66c82975f10b42865a301ca00a))

## [0.2.10](https://github.com/langwatch/scenario/compare/javascript/v0.2.9...javascript/v0.2.10) (2025-07-30)


### Features

* multimodal audio ([#110](https://github.com/langwatch/scenario/issues/110)) ([cc5d767](https://github.com/langwatch/scenario/commit/cc5d76745ff87f2e487c3aa495197802f84e637f))
* send more error info ([#118](https://github.com/langwatch/scenario/issues/118)) ([53f807b](https://github.com/langwatch/scenario/commit/53f807bac831638e27894c75337b533c4382b0d9))


### Bug Fixes

* correctly handle error example ([#117](https://github.com/langwatch/scenario/issues/117)) ([0ddd244](https://github.com/langwatch/scenario/commit/0ddd244c30c0b4c63e55d405d57acd94cbdc91de))
* send message snapshots after new messages ([#116](https://github.com/langwatch/scenario/issues/116)) ([eae6461](https://github.com/langwatch/scenario/commit/eae6461ae7737a8bce3188c71dc3d6b10dd67345))
* stop capturing errors, rethrow for much better debuggability ([#113](https://github.com/langwatch/scenario/issues/113)) ([a300ce4](https://github.com/langwatch/scenario/commit/a300ce470db6894ce20549893ac9ac2f56808e2b))
* update env loading strategy ([#115](https://github.com/langwatch/scenario/issues/115)) ([b657e84](https://github.com/langwatch/scenario/commit/b657e8476d771e5b2d50e03cc7ab3155c40bd1fc))


### Documentation

* examples improvements and language selection ([#114](https://github.com/langwatch/scenario/issues/114)) ([49f6522](https://github.com/langwatch/scenario/commit/49f65229802217504cfc1f613c0016a2beeb96cb))

## [0.2.9](https://github.com/langwatch/scenario/compare/javascript/v0.2.8...javascript/v0.2.9) (2025-07-10)


### Features

* better reporting python ([#44](https://github.com/langwatch/scenario/issues/44)) ([e41413b](https://github.com/langwatch/scenario/commit/e41413b5407d5e48e70825de4c38dbfb2600ef70))
* **javascript:** improve batch run support to work without env var in test environments ([#86](https://github.com/langwatch/scenario/issues/86)) ([bfd20ff](https://github.com/langwatch/scenario/commit/bfd20ff1a12a8c68153dabc70b7313bab97ac72d))


### Miscellaneous

* rename config level env var ([#79](https://github.com/langwatch/scenario/issues/79)) ([92336b8](https://github.com/langwatch/scenario/commit/92336b875ffbc1926597c3fc601594fb1ed804fd))
* tool call docs ([#87](https://github.com/langwatch/scenario/issues/87)) ([e8ad793](https://github.com/langwatch/scenario/commit/e8ad793a3106e9578180084a46bcb616f1bdd15b))

## [0.2.8](https://github.com/langwatch/scenario/compare/javascript/v0.2.7...javascript/v0.2.8) (2025-06-30)


### Bug Fixes

* try to get release-please to work ([a4ff895](https://github.com/langwatch/scenario/commit/a4ff895af5490ed854940ffa387667247ee8d6c9))

## [0.2.7](https://github.com/langwatch/scenario/compare/javascript/v0.2.6...javascript/v0.2.7) (2025-06-30)


### Bug Fixes

* add comment ([59c1b86](https://github.com/langwatch/scenario/commit/59c1b860c56f95e0cc766c8cd1e86428439c4b6f))

## [0.2.6](https://github.com/langwatch/scenario/compare/javascript/v0.2.5...javascript/v0.2.6) (2025-06-30)


### Features

* add multimodal images scenarios ([#82](https://github.com/langwatch/scenario/issues/82)) ([edee80c](https://github.com/langwatch/scenario/commit/edee80c339eb7be1641f60237cf6c02ea45c3b82))


### Miscellaneous

* doc config updates ([#78](https://github.com/langwatch/scenario/issues/78)) ([386fa7f](https://github.com/langwatch/scenario/commit/386fa7f52a85cf24feda0d5c90cde51030b03c3f))

## [0.2.5](https://github.com/langwatch/scenario/compare/javascript/v0.2.4...javascript/v0.2.5) (2025-06-26)


### Bug Fixes

* cleanup comment ([#76](https://github.com/langwatch/scenario/issues/76)) ([b8a685c](https://github.com/langwatch/scenario/commit/b8a685cc16b93a9fa2f6d753de54ab5444a051a9))

## [0.2.4](https://github.com/langwatch/scenario/compare/javascript/v0.2.3...javascript/v0.2.4) (2025-06-26)


### Bug Fixes

* update docs ([#70](https://github.com/langwatch/scenario/issues/70)) ([0990b1f](https://github.com/langwatch/scenario/commit/0990b1fcfc652171dd0b9b7bc25a4d61c7fc8121))

## [0.2.3](https://github.com/langwatch/scenario/compare/javascript/v0.2.2...javascript/v0.2.3) (2025-06-26)


### Features

* multilingual example ([#53](https://github.com/langwatch/scenario/issues/53)) ([3a594af](https://github.com/langwatch/scenario/commit/3a594afc47b630ff035d3fc1ed4a179f502f6a78))


### Bug Fixes

* **javascript:** jsdoc's were missing from the default export due to being copied to an object ([#46](https://github.com/langwatch/scenario/issues/46)) ([957ab3b](https://github.com/langwatch/scenario/commit/957ab3b0d2a0e49cc34c64f5b6616078f7ca643e))


### Miscellaneous

* **main:** release scenario 0.3.0 ([#55](https://github.com/langwatch/scenario/issues/55)) ([7a3ec89](https://github.com/langwatch/scenario/commit/7a3ec8940079cb55f2535063e6a6b1471f0a2989))
* use release-please ([#51](https://github.com/langwatch/scenario/issues/51)) ([3427848](https://github.com/langwatch/scenario/commit/342784875bd3ffa8fbf39b8ecca3a14ec8fb8661))

## [0.2.1](https://github.com/langwatch/scenario/compare/javascript/v0.2.0...javascript/v0.2.1) (2025-01-12)

### Bug Fixes

- expose system prompt ([#49](https://github.com/langwatch/scenario/issues/49)) ba902f2
