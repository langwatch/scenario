# Changelog

## [0.4.3](https://github.com/langwatch/scenario/compare/javascript/v0.4.2...javascript/v0.4.3) (2026-02-26)


### Features

* add extensible metadata support to ScenarioConfig ([#228](https://github.com/langwatch/scenario/issues/228)) ([36c2179](https://github.com/langwatch/scenario/commit/36c21790ff252a6f77a3251f16ff644d9cb5b11f))
* add extensible metadata support to ScenarioConfig ([#234](https://github.com/langwatch/scenario/issues/234)) ([36c2179](https://github.com/langwatch/scenario/commit/36c21790ff252a6f77a3251f16ff644d9cb5b11f))
* add runId to results and langwatch config options ([#207](https://github.com/langwatch/scenario/issues/207)) ([5cad11b](https://github.com/langwatch/scenario/commit/5cad11b9f0e97b5d1ad4a81370f8db74f76e4fa5))
* add runId to results and programmatic langwatch config ([5cad11b](https://github.com/langwatch/scenario/commit/5cad11b9f0e97b5d1ad4a81370f8db74f76e4fa5))
* lazy observability init with configurable span filtering (TypeScript + Python) ([#237](https://github.com/langwatch/scenario/issues/237)) ([8b02161](https://github.com/langwatch/scenario/commit/8b02161f22c343631be71f9061e3f4e149e5e0b5))
* stream realtime conversation audio through ffplay during tests ([b255eda](https://github.com/langwatch/scenario/commit/b255edad21440d3a86bff9262c6efb4893cfd968))


### Bug Fixes

* add connection retry for flaky realtime API tests ([#233](https://github.com/langwatch/scenario/issues/233)) ([25d73c5](https://github.com/langwatch/scenario/commit/25d73c51d5ee8c6a0c9c6512c8cf328f74ee3d14)), closes [#232](https://github.com/langwatch/scenario/issues/232)
* correct OpenTelemetry span parenting for scenario turns ([#239](https://github.com/langwatch/scenario/issues/239)) ([55beb9b](https://github.com/langwatch/scenario/commit/55beb9ba340ce0b36cabd9e30025c5d580cd5298))


### Miscellaneous

* switch gpt-4.1 to gpt-4.1-mini to reduce costs ([bcf5365](https://github.com/langwatch/scenario/commit/bcf53655eff3f60f7143ac63cdb072dc676cb2cc))
* switch gpt-4.1 to gpt-5-mini to reduce costs ([#231](https://github.com/langwatch/scenario/issues/231)) ([bcf5365](https://github.com/langwatch/scenario/commit/bcf53655eff3f60f7143ac63cdb072dc676cb2cc))


### Documentation

* add custom judge documentation ([#227](https://github.com/langwatch/scenario/issues/227)) ([0b02068](https://github.com/langwatch/scenario/commit/0b02068b78c22c12db61e08631a8937bbc54ef19))

## [0.4.2](https://github.com/langwatch/scenario/compare/javascript/v0.4.1...javascript/v0.4.2) (2026-02-18)


### Features

* inline criteria on scenario.judge() script steps ([#223](https://github.com/langwatch/scenario/issues/223)) ([84767fa](https://github.com/langwatch/scenario/commit/84767fae39b47c9a91e6659497271b470374a318))


### Bug Fixes

* scenarios v3 model spec ([#220](https://github.com/langwatch/scenario/issues/220)) ([c2a3914](https://github.com/langwatch/scenario/commit/c2a391417827096c04e139889c70a5aca6bdfce6))

## [0.4.1](https://github.com/langwatch/scenario/compare/javascript/v0.4.0...javascript/v0.4.1) (2026-02-10)


### Features

* **python:** add span-based evaluation for judge agent ([#188](https://github.com/langwatch/scenario/issues/188)) ([59352ec](https://github.com/langwatch/scenario/commit/59352ec0e36faf2efb3239fde4082d0ee0d80168))


### Bug Fixes

* update description ([#151](https://github.com/langwatch/scenario/issues/151)) ([b17294c](https://github.com/langwatch/scenario/commit/b17294cfb7522f274e07bef6eb5f06c090d95ab6))


### Miscellaneous

* ai v5 to v6 ([#218](https://github.com/langwatch/scenario/issues/218)) ([3b053ec](https://github.com/langwatch/scenario/commit/3b053ec9a1ef7ace2e50ad799fbf0f868bc98b37))


### Code Refactoring

* use SDK constants for thread ID attribute ([#195](https://github.com/langwatch/scenario/issues/195)) ([c621340](https://github.com/langwatch/scenario/commit/c621340ea90e7456887108f1c344a6128c97af6b))

## [0.4.0](https://github.com/langwatch/scenario/compare/javascript/v0.3.1...javascript/v0.4.0) (2025-12-04)


### ⚠ BREAKING CHANGES

* DigestDeduplicator class removed, use new modules directly

### Features

* add invokeLLM extension point for customizing LLM behavior  ([#167](https://github.com/langwatch/scenario/issues/167)) ([a721cd0](https://github.com/langwatch/scenario/commit/a721cd00fde0b289b539133b9abc84f2cdf37dc4))
* add openai realtime support ([#155](https://github.com/langwatch/scenario/issues/155)) ([24fa46c](https://github.com/langwatch/scenario/commit/24fa46c4b7b7632bc0428c11b7297c19fc5d6fd0))
* implement trace-per-turn architecture with message correlation ([#173](https://github.com/langwatch/scenario/issues/173)) ([27088f3](https://github.com/langwatch/scenario/commit/27088f3a70c4e3bba447ec0a31cd14baf7d7847a))
* **realtime:** add LangWatch Scenario expert voice agent demo ([#160](https://github.com/langwatch/scenario/issues/160)) ([8f67f24](https://github.com/langwatch/scenario/commit/8f67f24985cc337bb23a27423e5df277bb677994))
* refactor scenario judge to grade against traces ([#177](https://github.com/langwatch/scenario/issues/177)) ([3040d97](https://github.com/langwatch/scenario/commit/3040d97a29f08fa235d41cb58c73f3774c844172))


### Documentation

* add long timeout by default on the ts examples ([a39b15a](https://github.com/langwatch/scenario/commit/a39b15a988f6705e89681651aaf68ad66f232d0f))


### Code Refactoring

* reorganize realtime example and split audio judge helpers ([#169](https://github.com/langwatch/scenario/issues/169)) ([001b043](https://github.com/langwatch/scenario/commit/001b0430b8247c669f15565d263872af5985d1d8))
* **scripts:** simplify and organize pnpm package scripts ([#175](https://github.com/langwatch/scenario/issues/175)) ([8fd831b](https://github.com/langwatch/scenario/commit/8fd831bca88f9938d843d34c1a753ca5a0fec6fb))

## [0.3.1](https://github.com/langwatch/scenario/compare/javascript/v0.3.0...javascript/v0.3.1) (2025-10-21)


### Bug Fixes

* prevent judge from overwriting messages array ([#150](https://github.com/langwatch/scenario/issues/150)) ([1438ab5](https://github.com/langwatch/scenario/commit/1438ab59895b1d5663235ff9d4a54acadbaf12f9))
* update mocking examples ([#133](https://github.com/langwatch/scenario/issues/133)) ([95cb4e0](https://github.com/langwatch/scenario/commit/95cb4e09ff4a8b8ac895486a9f0f0f4345771054))
* voice agent example ([#134](https://github.com/langwatch/scenario/issues/134)) ([f2cccdc](https://github.com/langwatch/scenario/commit/f2cccdccd7d99d8c7879f811130401a2e5b3f587))


### Miscellaneous

* add black box testing examples ([#137](https://github.com/langwatch/scenario/issues/137)) ([87fec91](https://github.com/langwatch/scenario/commit/87fec9114b17f5c4b27f054e7adc074de8b761f3))

## [0.3.0](https://github.com/langwatch/scenario/compare/javascript/v0.2.13...javascript/v0.3.0) (2025-08-30)


### ⚠ BREAKING CHANGES

* upgrade to vercel ai sdk v5 ([#128](https://github.com/langwatch/scenario/issues/128))

### Features

* upgrade to vercel ai sdk v5 ([#128](https://github.com/langwatch/scenario/issues/128)) ([7d2ca68](https://github.com/langwatch/scenario/commit/7d2ca68d6b224f4c917da7dc632fc32adc8d4104))


### Bug Fixes

* open only one browser window and print only one watch/greeting message if running in multiple workers ([a4d5a52](https://github.com/langwatch/scenario/commit/a4d5a522c4533412002a0471467be685a6cdf10f))
* show green/red colors only if there really are any success/failures to be less confusing ([34e82f9](https://github.com/langwatch/scenario/commit/34e82f9dc672f37307e649b435693342a3a47326))

## [0.2.13](https://github.com/langwatch/scenario/compare/javascript/v0.2.12...javascript/v0.2.13) (2025-08-29)


### Features

* open browser automatically on langwatch page for following scenario runs + improve console output to be less over the top + ksuid instead of uuids ([#122](https://github.com/langwatch/scenario/issues/122)) ([9216833](https://github.com/langwatch/scenario/commit/9216833c30db79b0e5a9ae29a16e481e30165353))

## [0.2.12](https://github.com/langwatch/scenario/compare/javascript/v0.2.11...javascript/v0.2.12) (2025-08-01)


### Bug Fixes

* duplicate examples names ([4e91a42](https://github.com/langwatch/scenario/commit/4e91a42f6ce35ee54d85623b370653cfc38df478))
* let dependencies be more flexible, bump all ([05bb556](https://github.com/langwatch/scenario/commit/05bb5564c7e6f60b128cdfc2f1dff0fda2dedd6f))

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
