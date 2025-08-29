# Changelog

## [0.7.9](https://github.com/langwatch/scenario/compare/python/v0.7.8...python/v0.7.9) (2025-08-29)


### Features

* open browser automatically on langwatch page for following scenario runs + improve console output to be less over the top + ksuid instead of uuids ([#122](https://github.com/langwatch/scenario/issues/122)) ([9216833](https://github.com/langwatch/scenario/commit/9216833c30db79b0e5a9ae29a16e481e30165353))


### Bug Fixes

* consider inconclusive criteria as failure ([#125](https://github.com/langwatch/scenario/issues/125)) ([5f93d33](https://github.com/langwatch/scenario/commit/5f93d3307c3f3483ba5161e00f9065826782a283))
* documentation links ([#106](https://github.com/langwatch/scenario/issues/106)) ([24806f8](https://github.com/langwatch/scenario/commit/24806f8dc14d602752159421c014547e51f777a5))
* stop capturing errors, rethrow for much better debuggability ([#113](https://github.com/langwatch/scenario/issues/113)) ([a300ce4](https://github.com/langwatch/scenario/commit/a300ce470db6894ce20549893ac9ac2f56808e2b))


### Documentation

* examples improvements and language selection ([#114](https://github.com/langwatch/scenario/issues/114)) ([49f6522](https://github.com/langwatch/scenario/commit/49f65229802217504cfc1f613c0016a2beeb96cb))

## [0.7.8](https://github.com/langwatch/scenario/compare/python/v0.7.7...python/v0.7.8) (2025-07-10)


### Features

* update python configure to accept api_base ([#97](https://github.com/langwatch/scenario/issues/97)) ([4418a0c](https://github.com/langwatch/scenario/commit/4418a0c73687fb437791e8994320d01f76f47383))


### Miscellaneous

* tool call docs ([#87](https://github.com/langwatch/scenario/issues/87)) ([e8ad793](https://github.com/langwatch/scenario/commit/e8ad793a3106e9578180084a46bcb616f1bdd15b))

## [0.7.7](https://github.com/langwatch/scenario/compare/python/v0.7.6...python/v0.7.7) (2025-07-07)


### Features

* better reporting python ([#44](https://github.com/langwatch/scenario/issues/44)) ([e41413b](https://github.com/langwatch/scenario/commit/e41413b5407d5e48e70825de4c38dbfb2600ef70))


### Bug Fixes

* get reporter to work and with default ([#96](https://github.com/langwatch/scenario/issues/96)) ([4109a51](https://github.com/langwatch/scenario/commit/4109a51ef9b4b578f4a63cce19959645d6887f94))

## [0.7.6](https://github.com/langwatch/scenario/compare/python/v0.7.5...python/v0.7.6) (2025-06-26)


### Bug Fixes

* update docs ([#70](https://github.com/langwatch/scenario/issues/70)) ([0990b1f](https://github.com/langwatch/scenario/commit/0990b1fcfc652171dd0b9b7bc25a4d61c7fc8121))

## [0.7.5](https://github.com/langwatch/scenario/compare/python/v0.7.4...python/v0.7.5) (2025-06-26)


### Features

* add set id support to python ([#27](https://github.com/langwatch/scenario/issues/27)) ([32637cb](https://github.com/langwatch/scenario/commit/32637cb847fec4c52d39f0250aaeee496a24b3b6))
* easy publish ([#16](https://github.com/langwatch/scenario/issues/16)) ([4a41816](https://github.com/langwatch/scenario/commit/4a41816ea5b97f9dc19e9a69fac524d39092011f))
* make messages passed around a bit more forgiving, to not break at reporting level, and ignore pydantic warnings on conversions that actually work fine ([b50c716](https://github.com/langwatch/scenario/commit/b50c716758229e3e1478f941588c1540772767af))
* run unit tests before publish ([0044d4d](https://github.com/langwatch/scenario/commit/0044d4da722adf72d72dd4a4465cc5b886229988))


### Bug Fixes

* add missing python-dateutil dependency, necessary for generated api calls ([915d1b3](https://github.com/langwatch/scenario/commit/915d1b34e0008dcac2d620033a6fcecd0f12408c))
* endpoint typo fixes ([#41](https://github.com/langwatch/scenario/issues/41)) ([71a9369](https://github.com/langwatch/scenario/commit/71a93691cbe9244b339e9bd481eeea9412bcf8ad))
* fix commitizen version ([bd71534](https://github.com/langwatch/scenario/commit/bd71534ee228644bf79ea1efb366f5515c1ae03b))
* fix having backslash on f-string which doesn't compile sometimes ([3d6bad7](https://github.com/langwatch/scenario/commit/3d6bad7595407725d330cc7cfe2e8ee50d112851))
* little nudge for gpt-4.1 stop following up as the assistant ([ee035c0](https://github.com/langwatch/scenario/commit/ee035c0399a38cd7150168048db352f39ea0b61b))
* message snapshot run id ([#14](https://github.com/langwatch/scenario/issues/14)) ([d01b4c8](https://github.com/langwatch/scenario/commit/d01b4c84e2a001e61169442558efa3d3d63e0bff))
* pdocs reference generation ([#25](https://github.com/langwatch/scenario/issues/25)) ([546acd7](https://github.com/langwatch/scenario/commit/546acd73d143e968ffbd3247f03627cc68077892))
* tool call messages ([#20](https://github.com/langwatch/scenario/issues/20)) ([a1417b8](https://github.com/langwatch/scenario/commit/a1417b85c00670e71ad89e201bb96c0416d7b762))


### Miscellaneous

* finish monorepo migration ([#12](https://github.com/langwatch/scenario/issues/12)) ([8cff71e](https://github.com/langwatch/scenario/commit/8cff71e6c98f72b760603e6ddd6275882f2d9540))
* match endpoint naming and behaviour with js library and other langwatch sdk ([#15](https://github.com/langwatch/scenario/issues/15)) ([a1f55b1](https://github.com/langwatch/scenario/commit/a1f55b17bf2dff4250ab1843fb054c100563dd5d))
* python 0.5.0 ([#13](https://github.com/langwatch/scenario/issues/13)) ([ce87328](https://github.com/langwatch/scenario/commit/ce87328ad23e3dc085bd18f46a6cc7632f032471))
* release python 0.7.3 ([#35](https://github.com/langwatch/scenario/issues/35)) ([cd6d73a](https://github.com/langwatch/scenario/commit/cd6d73af7701ba192e0c5647bcc9101fb1ce2bd5))
* remove using direct private method example and notes that are not really true ([c16f07d](https://github.com/langwatch/scenario/commit/c16f07de3e3a852423d9b3c8e7f360cc372fec46))
* update python and ts package versions ([#45](https://github.com/langwatch/scenario/issues/45)) ([bce696d](https://github.com/langwatch/scenario/commit/bce696de47e6b16cb4ee447a13573b60f68a202a))
* use release-please ([#51](https://github.com/langwatch/scenario/issues/51)) ([3427848](https://github.com/langwatch/scenario/commit/342784875bd3ffa8fbf39b8ecca3a14ec8fb8661))


### Documentation

* bring previous readme mostly back ([7db4221](https://github.com/langwatch/scenario/commit/7db422102f01db61b3ff68fd59b59181663512f3))
* fix pdoc make generation command ([0af2d11](https://github.com/langwatch/scenario/commit/0af2d11b4b9e97df6ad5fcb83fdea983480a8594))
* small pdoc improvement ([209fec6](https://github.com/langwatch/scenario/commit/209fec658e218873616991f6f3433aa0ca7e28a5))


### Code Refactoring

* move run to separate function ([#24](https://github.com/langwatch/scenario/issues/24)) ([81bde7d](https://github.com/langwatch/scenario/commit/81bde7d73378ebcb3718e4f1c2e084df8c7b1486))
* move some deps to be dev only, they are not needed for the library user ([ec02c71](https://github.com/langwatch/scenario/commit/ec02c71ab1be454be24e4a188e831a86dc3b6156))
* use better rx subscription and handle immediate publishing ([#18](https://github.com/langwatch/scenario/issues/18)) ([cab1442](https://github.com/langwatch/scenario/commit/cab14420b202bb9493b1cb84cf0e384330b2b94b))

## [0.7.4](https://github.com/langwatch/scenario/compare/python/v0.7.3...python/v0.7.4) (2025-01-12)

### Bug Fixes

- expose system prompt ([#49](https://github.com/langwatch/scenario/issues/49)) ba902f2
