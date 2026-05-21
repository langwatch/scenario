# Changelog

## [0.7.27](https://github.com/langwatch/scenario/compare/python/v0.7.26...python/v0.7.27) (2026-05-21)


### Features

* **#350:** voice agents — first-class voice in scenario.run() ([#355](https://github.com/langwatch/scenario/issues/355)) ([128ac94](https://github.com/langwatch/scenario/commit/128ac947d7c3412b57acb6d15358e96b0af4a1ad))
* **#452:** voice docs surface — legacy deprecation + new section scaffold ([#456](https://github.com/langwatch/scenario/issues/456)) ([1b07abb](https://github.com/langwatch/scenario/commit/1b07abbfaf503408368f4f82b8ab8319cbfd366a))
* add GOAT strategy with dynamic technique selection for RedTeamAgent ([#346](https://github.com/langwatch/scenario/issues/346)) ([2896c97](https://github.com/langwatch/scenario/commit/2896c97e9a534a9ff1817904053a6af4f1ad06a4))
* **ci/#364:** add pr-auto-approve.yml as passive observer (PR [#1](https://github.com/langwatch/scenario/issues/1) of 4) ([#485](https://github.com/langwatch/scenario/issues/485)) ([4d84597](https://github.com/langwatch/scenario/commit/4d8459710e566ac90ad731164a4506f6d81365eb))
* **red-team:** zero-friction report dashboard — auto-save + `scenario redteam-report` CLI ([2896c97](https://github.com/langwatch/scenario/commit/2896c97e9a534a9ff1817904053a6af4f1ad06a4))


### Bug Fixes

* **deps:** bump filelock to &gt;=3.20.3 for TOCTOU/symlink CVEs ([#481](https://github.com/langwatch/scenario/issues/481)) ([479ec82](https://github.com/langwatch/scenario/commit/479ec8218afcc2f92632dbdce4b71e963fcf953b))
* **deps:** bump pytest to &gt;=9.0.3 for CVE-2025-71176 ([#479](https://github.com/langwatch/scenario/issues/479)) ([4f4ffd4](https://github.com/langwatch/scenario/commit/4f4ffd4bdbe829dd06e534c69e1ee7be25164917))
* **deps:** bump python-liquid to &gt;=2.2.0 for high severity CVE ([#459](https://github.com/langwatch/scenario/issues/459)) ([60bad76](https://github.com/langwatch/scenario/commit/60bad7633208bb72056408bf3b6c0b9824c21915))
* **deps:** bump urllib3 to &gt;=2.7.0 for high severity CVEs ([#457](https://github.com/langwatch/scenario/issues/457)) ([50c3cea](https://github.com/langwatch/scenario/commit/50c3cea6acdefaf65b9b84a925db41a206b15cce))
* **deps:** bump virtualenv to &gt;=20.36.1 for CVE-2026-22702 ([#483](https://github.com/langwatch/scenario/issues/483)) ([8f10690](https://github.com/langwatch/scenario/commit/8f1069002fa968e9ce17874bbb15b86e24714228))
* **deps:** override minimatch to &gt;=9.0.6 (CVE-2026-26996) ([#395](https://github.com/langwatch/scenario/issues/395)) ([ceb0b59](https://github.com/langwatch/scenario/commit/ceb0b59e6a96fe27adf865f03aa1de8a9ea03357))
* **deps:** resolve 4 high-severity Dependabot security alerts ([#393](https://github.com/langwatch/scenario/issues/393)) ([97f257d](https://github.com/langwatch/scenario/commit/97f257ddc30a6bd7a9cca65e2e62e0ed0c688085))
* **docs:** exclude scenario.report.app from pdoc to unblock Publish Docs ([#388](https://github.com/langwatch/scenario/issues/388)) ([3736c87](https://github.com/langwatch/scenario/commit/3736c871d74bef4c81b696882786e84e23cf86e8))
* **examples:** stabilize custom LLM judge criteria matching ([#396](https://github.com/langwatch/scenario/issues/396)) ([f4b536c](https://github.com/langwatch/scenario/commit/f4b536cf12a6d525b487c672f9451390e13957c7))
* **examples:** stabilize vegetarian-agent parallel tests on python-ci ([#389](https://github.com/langwatch/scenario/issues/389)) ([e40eee3](https://github.com/langwatch/scenario/commit/e40eee3276bbe967ab4ac465b3cd9048f74c8421))
* **examples:** strengthen vegetarian-agent prompt to stabilize parallel tests ([e40eee3](https://github.com/langwatch/scenario/commit/e40eee3276bbe967ab4ac465b3cd9048f74c8421))
* **examples:** use positional index matching in custom judge examples ([f4b536c](https://github.com/langwatch/scenario/commit/f4b536cf12a6d525b487c672f9451390e13957c7))
* **judge:** harden forceVerdict so discovery tools cannot leak (JS + Python) ([#377](https://github.com/langwatch/scenario/issues/377)) ([0e2859f](https://github.com/langwatch/scenario/commit/0e2859f5ec1c171fa3d3d6f89b7d59555be6b95b))
* **red-team:** annotate H_attacker when post-hoc injection fires ([#326](https://github.com/langwatch/scenario/issues/326), [#334](https://github.com/langwatch/scenario/issues/334)) ([2896c97](https://github.com/langwatch/scenario/commit/2896c97e9a534a9ff1817904053a6af4f1ad06a4))
* **security:** bump litellm to fix 4 high-severity CVEs ([#411](https://github.com/langwatch/scenario/issues/411)) ([f6ff8a3](https://github.com/langwatch/scenario/commit/f6ff8a3b4e4d34df6d9a6b72c0a69afa8daaea3b))
* **security:** patch CVE-2026-27903 in minimatch ([#398](https://github.com/langwatch/scenario/issues/398)) ([b61cc60](https://github.com/langwatch/scenario/commit/b61cc6005645b7703788c02c6cb4d134559e339b))
* **security:** patch flatted prototype pollution via parse() ([#421](https://github.com/langwatch/scenario/issues/421)) ([3a20e6c](https://github.com/langwatch/scenario/commit/3a20e6c57bb81583144cb643d3fcac390f66af3b))
* **security:** patch glob CLI command injection in lovable_clone npm lockfile ([#413](https://github.com/langwatch/scenario/issues/413)) ([d1b3297](https://github.com/langwatch/scenario/commit/d1b3297c47e28dfac2b1940c24223a3e32ec89ba))
* **security:** patch glob CLI command injection in lovable_clone template npm lockfile ([d1b3297](https://github.com/langwatch/scenario/commit/d1b3297c47e28dfac2b1940c24223a3e32ec89ba))
* **security:** patch picomatch ReDoS in lovable_clone npm lockfile ([#409](https://github.com/langwatch/scenario/issues/409)) ([70a5ff9](https://github.com/langwatch/scenario/commit/70a5ff9e5ecfddc7c20eeb62cab7e8fa77240017))
* **security:** patch react-router XSS and open redirect CVEs ([#418](https://github.com/langwatch/scenario/issues/418)) ([2b6797a](https://github.com/langwatch/scenario/commit/2b6797acd9063adb71b6d6ea80070aaf17431bb6))
* **security:** patch rollup arbitrary file write via path traversal ([#399](https://github.com/langwatch/scenario/issues/399)) ([55a0259](https://github.com/langwatch/scenario/commit/55a02598ad8d245dfac159357b17c8d89192b824))
* **security:** patch rollup path traversal CVE (&gt;= 4.0.0, &lt; 4.59.0) ([55a0259](https://github.com/langwatch/scenario/commit/55a02598ad8d245dfac159357b17c8d89192b824))
* **security:** upgrade aiohttp to fix zip bomb and other CVEs ([#417](https://github.com/langwatch/scenario/issues/417)) ([a747624](https://github.com/langwatch/scenario/commit/a747624520eb9e6370a3e596baadba2610ef08f6))
* **security:** upgrade black to fix arbitrary file write CVE ([#403](https://github.com/langwatch/scenario/issues/403)) ([6583942](https://github.com/langwatch/scenario/commit/65839421f3bc2aa1162c9c122f3015caa4794331))
* **security:** upgrade black to fix arbitrary file write via cache file name ([6583942](https://github.com/langwatch/scenario/commit/65839421f3bc2aa1162c9c122f3015caa4794331))
* **security:** upgrade mcp Python SDK to fix DoS and DNS rebinding CVEs ([#406](https://github.com/langwatch/scenario/issues/406)) ([25e2e1c](https://github.com/langwatch/scenario/commit/25e2e1ca56fb860f1ec4b436f95b44f4b6ba51ac))
* **security:** upgrade pyasn1 to fix DoS via unbounded recursion ([2880a73](https://github.com/langwatch/scenario/commit/2880a73233d0fd5d7c6445d5bfaa5bb84048e8d9))
* **security:** upgrade pyasn1 to fix DoS vulnerabilities ([#401](https://github.com/langwatch/scenario/issues/401)) ([2880a73](https://github.com/langwatch/scenario/commit/2880a73233d0fd5d7c6445d5bfaa5bb84048e8d9))
* **security:** upgrade pydantic-ai to fix SSRF vulnerability ([#405](https://github.com/langwatch/scenario/issues/405)) ([f7ec414](https://github.com/langwatch/scenario/commit/f7ec414375ca165c62bf231f6aa0e988b3140d84))
* **security:** upgrade python-multipart to fix arbitrary file write CVE ([#407](https://github.com/langwatch/scenario/issues/407)) ([1f2bb80](https://github.com/langwatch/scenario/commit/1f2bb80e4fdf70fa600f09c23f30fed01995f3d1))
* **security:** upgrade starlette to fix DoS via Range header merging ([#402](https://github.com/langwatch/scenario/issues/402)) ([11135a7](https://github.com/langwatch/scenario/commit/11135a780521fc169211665102d1bf3e6766706e))
* **security:** upgrade urllib3 to fix decompression bomb CVEs ([#404](https://github.com/langwatch/scenario/issues/404)) ([1b00ea2](https://github.com/langwatch/scenario/commit/1b00ea2bbafc387eeda7cd9f04e3c7274ac27772))
* **voice:** render audio messages cleanly in the terminal ([#497](https://github.com/langwatch/scenario/issues/497)) ([bb4ff9b](https://github.com/langwatch/scenario/commit/bb4ff9bb13c041050a87ff4618a2f8476ee219dd))
* **voice:** stub bot barge-in cancelled STT mid-pipeline, dropping user transcripts ([#499](https://github.com/langwatch/scenario/issues/499)) ([5cb3596](https://github.com/langwatch/scenario/commit/5cb35960cd294c8b1e3c867dbccadf86205af891))


### Miscellaneous

* **deps-dev:** bump vite, @vitejs/plugin-react-swc and lovable-tagger ([e43f938](https://github.com/langwatch/scenario/commit/e43f9386b8122de9f0c077b473083bdb3c9f9478))
* **deps-dev:** bump vite, @vitejs/plugin-react-swc and lovable-tagger in /python/examples/lovable_clone/template ([#429](https://github.com/langwatch/scenario/issues/429)) ([e43f938](https://github.com/langwatch/scenario/commit/e43f9386b8122de9f0c077b473083bdb3c9f9478))
* **deps:** bump black from 25.1.0 to 26.3.1 in /python ([#431](https://github.com/langwatch/scenario/issues/431)) ([07db40a](https://github.com/langwatch/scenario/commit/07db40a07cd53c5b6aa15c4bb0c36b9fa06db164))
* **deps:** bump gitpython from 3.1.49 to 3.1.50 in /python ([#447](https://github.com/langwatch/scenario/issues/447)) ([3fcd1fa](https://github.com/langwatch/scenario/commit/3fcd1fa5eadb77b9dad5c055cdd6047f3639647a))
* **deps:** bump mako from 1.3.10 to 1.3.12 in /python ([#448](https://github.com/langwatch/scenario/issues/448)) ([ab4d576](https://github.com/langwatch/scenario/commit/ab4d5764aaadb87b73182287d4232750ca4fbebb))
* **deps:** bump protobuf from 5.29.5 to 5.29.6 in /python ([#433](https://github.com/langwatch/scenario/issues/433)) ([6ea6ed7](https://github.com/langwatch/scenario/commit/6ea6ed79e175df6458943a22e66976315fa2f720))
* **deps:** bump pyasn1 from 0.6.1 to 0.6.3 in /python ([#432](https://github.com/langwatch/scenario/issues/432)) ([ee837e7](https://github.com/langwatch/scenario/commit/ee837e7ac87ddc6ecada5651db5a5caf53cd0236))
* **deps:** bump python-multipart from 0.0.20 to 0.0.26 in /python ([#430](https://github.com/langwatch/scenario/issues/430)) ([0b29bbb](https://github.com/langwatch/scenario/commit/0b29bbbb18b833d3fe5bee8de3d80de8b9ebe69c))
* **deps:** bump python-multipart from 0.0.26 to 0.0.27 in /python ([#449](https://github.com/langwatch/scenario/issues/449)) ([e5467b3](https://github.com/langwatch/scenario/commit/e5467b366870bb6d368ec093dd910292477e2934))
* **deps:** bump starlette from 0.47.0 to 0.49.1 in /python ([#434](https://github.com/langwatch/scenario/issues/434)) ([5263fed](https://github.com/langwatch/scenario/commit/5263fed39b4a8c8404ca1f6581352d6f7921f682))
* **deps:** bump urllib3 from 1.26.20 to 2.6.3 in /python ([#435](https://github.com/langwatch/scenario/issues/435)) ([1793d64](https://github.com/langwatch/scenario/commit/1793d6463cf6298d45aaba082171cd900bb49037))

## [0.7.26](https://github.com/langwatch/scenario/compare/python/v0.7.25...python/v0.7.26) (2026-04-28)


### Bug Fixes

* **events:** dual-emit auth + graceful empty-key handling in Python EventReporter ([#383](https://github.com/langwatch/scenario/issues/383)) ([f9a87aa](https://github.com/langwatch/scenario/commit/f9a87aada92017be01122ff2884cdd99b270e464))

## [0.7.25](https://github.com/langwatch/scenario/compare/python/v0.7.24...python/v0.7.25) (2026-04-23)


### Miscellaneous

* relicense from AGPLv3 to Apache 2.0 ([66ad733](https://github.com/langwatch/scenario/commit/66ad73312c805c320232059635bab5cbc3c75be1))
* relicense to Apache 2.0 ([#378](https://github.com/langwatch/scenario/issues/378)) ([66ad733](https://github.com/langwatch/scenario/commit/66ad73312c805c320232059635bab5cbc3c75be1))

## [0.7.24](https://github.com/langwatch/scenario/compare/python/v0.7.23...python/v0.7.24) (2026-04-18)


### Features

* add GOAT strategy with dynamic technique selection for RedTeamAgent ([#306](https://github.com/langwatch/scenario/issues/306)) ([e62c292](https://github.com/langwatch/scenario/commit/e62c292dbb46bbc6a7afd312604746541b02e84f))
* **python:** add async-native scenario.arun for loop-bound resources ([#369](https://github.com/langwatch/scenario/issues/369)) ([a797773](https://github.com/langwatch/scenario/commit/a79777353dcfd3a44648f329ed75cf1321ccdd13))

## [0.7.23](https://github.com/langwatch/scenario/compare/python/v0.7.22...python/v0.7.23) (2026-04-08)


### Bug Fixes

* force verdict on judge discovery exhaustion instead of hard-failing ([#315](https://github.com/langwatch/scenario/issues/315)) ([197f567](https://github.com/langwatch/scenario/commit/197f5673cfa4147c10b368ae095842b043026d8c))
* judge off-by-one, auto-run on script exhaustion, assertion criteria, marathon_script cleanup ([#289](https://github.com/langwatch/scenario/issues/289)) ([91f76d1](https://github.com/langwatch/scenario/commit/91f76d128a5d8c0cbe5c6b00337f279b4890ea57))

## [0.7.22](https://github.com/langwatch/scenario/compare/python/v0.7.21...python/v0.7.22) (2026-03-22)


### Features

* add scenario role and run_id attributes to agent spans ([#294](https://github.com/langwatch/scenario/issues/294)) ([d7e31cc](https://github.com/langwatch/scenario/commit/d7e31cc2db91be9594bec0c4c111ed9e7ddf5fe0))

## [0.7.21](https://github.com/langwatch/scenario/compare/python/v0.7.20...python/v0.7.21) (2026-03-13)


### Features

* dual conversation histories for RedTeamAgent ([#282](https://github.com/langwatch/scenario/issues/282)) ([fa45876](https://github.com/langwatch/scenario/commit/fa458760e73ac03061a7210b43f2bc0e1602be70))


### Bug Fixes

* resolve CI flaky tests ([#277](https://github.com/langwatch/scenario/issues/277)) ([de1a00b](https://github.com/langwatch/scenario/commit/de1a00bb6db5c87c98664f7748c95c949fe11997))

## [0.7.20](https://github.com/langwatch/scenario/compare/python/v0.7.19...python/v0.7.20) (2026-03-10)


### Features

* backtracking on hard refusals for RedTeamAgent ([#270](https://github.com/langwatch/scenario/issues/270)) ([62190a0](https://github.com/langwatch/scenario/commit/62190a0bd8dcf1314a148f25b60c8816af95561b))


### Bug Fixes

* align red teaming nomenclature between TypeScript and Python ([62190a0](https://github.com/langwatch/scenario/commit/62190a0bd8dcf1314a148f25b60c8816af95561b))
* resolve CI test failures blocking JS publish ([#275](https://github.com/langwatch/scenario/issues/275)) ([049a13b](https://github.com/langwatch/scenario/commit/049a13b7ae03e5985dc01d64ebd1b1c37999dfba))

## [0.7.19](https://github.com/langwatch/scenario/compare/python/v0.7.18...python/v0.7.19) (2026-03-07)


### Features

* add langwatch.origin="simulation" span attribute ([#264](https://github.com/langwatch/scenario/issues/264)) ([30fbdf0](https://github.com/langwatch/scenario/commit/30fbdf006c688ce43db1ad61e678fb0e28578266))


### Miscellaneous

* change license from MIT to AGPLv3 ([#258](https://github.com/langwatch/scenario/issues/258)) ([d3ac921](https://github.com/langwatch/scenario/commit/d3ac9213c0a1406aab630c3a034b2dcbb2166976))

## [0.7.18](https://github.com/langwatch/scenario/compare/python/v0.7.17...python/v0.7.18) (2026-03-05)


### Bug Fixes

* allow judge discovery tools before forced verdict on large traces ([#251](https://github.com/langwatch/scenario/issues/251)) ([3c32b01](https://github.com/langwatch/scenario/commit/3c32b0181d550e363d42438051bd48b8e4dd7880))
* resolve pyright type errors in judge discovery integration test ([96e385b](https://github.com/langwatch/scenario/commit/96e385b4cb497e8ea4e172d9c598a86b75f8671c))

## [0.7.17](https://github.com/langwatch/scenario/compare/python/v0.7.16...python/v0.7.17) (2026-03-03)


### Features

* add extensible metadata support to ScenarioConfig ([#228](https://github.com/langwatch/scenario/issues/228)) ([36c2179](https://github.com/langwatch/scenario/commit/36c21790ff252a6f77a3251f16ff644d9cb5b11f))
* add extensible metadata support to ScenarioConfig ([#234](https://github.com/langwatch/scenario/issues/234)) ([36c2179](https://github.com/langwatch/scenario/commit/36c21790ff252a6f77a3251f16ff644d9cb5b11f))
* lazy observability init with configurable span filtering (TypeScript + Python) ([#237](https://github.com/langwatch/scenario/issues/237)) ([8b02161](https://github.com/langwatch/scenario/commit/8b02161f22c343631be71f9061e3f4e149e5e0b5))
* progressive trace discovery for Python SDK + span ID improvements (both languages) ([#242](https://github.com/langwatch/scenario/issues/242)) ([716c8b7](https://github.com/langwatch/scenario/commit/716c8b71215f12e8548f642e4e99c9c8054d1e72))


### Bug Fixes

* add flaky markers to all LLM-calling example tests ([#244](https://github.com/langwatch/scenario/issues/244)) ([72c6a88](https://github.com/langwatch/scenario/commit/72c6a888fd5812936e73c3f983799693ba68881a))


### Miscellaneous

* switch gpt-4.1 to gpt-4.1-mini to reduce costs ([bcf5365](https://github.com/langwatch/scenario/commit/bcf53655eff3f60f7143ac63cdb072dc676cb2cc))
* switch gpt-4.1 to gpt-5-mini to reduce costs ([#231](https://github.com/langwatch/scenario/issues/231)) ([bcf5365](https://github.com/langwatch/scenario/commit/bcf53655eff3f60f7143ac63cdb072dc676cb2cc))


### Documentation

* add custom judge documentation ([#227](https://github.com/langwatch/scenario/issues/227)) ([0b02068](https://github.com/langwatch/scenario/commit/0b02068b78c22c12db61e08631a8937bbc54ef19))

## [0.7.16](https://github.com/langwatch/scenario/compare/python/v0.7.15...python/v0.7.16) (2026-02-18)


### Features

* inline criteria on scenario.judge() script steps ([#223](https://github.com/langwatch/scenario/issues/223)) ([84767fa](https://github.com/langwatch/scenario/commit/84767fae39b47c9a91e6659497271b470374a318))

## [0.7.15](https://github.com/langwatch/scenario/compare/python/v0.7.14...python/v0.7.15) (2026-01-13)


### Features

* **python:** add span-based evaluation for judge agent ([#188](https://github.com/langwatch/scenario/issues/188)) ([59352ec](https://github.com/langwatch/scenario/commit/59352ec0e36faf2efb3239fde4082d0ee0d80168))
* **realtime:** add LangWatch Scenario expert voice agent demo ([#160](https://github.com/langwatch/scenario/issues/160)) ([8f67f24](https://github.com/langwatch/scenario/commit/8f67f24985cc337bb23a27423e5df277bb677994))


### Miscellaneous

* metadata ([#197](https://github.com/langwatch/scenario/issues/197)) ([bbde20b](https://github.com/langwatch/scenario/commit/bbde20bf9448f71ddbb811ff3cf4ed3014895dd4))


### Code Refactoring

* use SDK constants for thread ID attribute ([#195](https://github.com/langwatch/scenario/issues/195)) ([c621340](https://github.com/langwatch/scenario/commit/c621340ea90e7456887108f1c344a6128c97af6b))

## [0.7.14](https://github.com/langwatch/scenario/compare/python/v0.7.13...python/v0.7.14) (2025-10-21)


### Bug Fixes

* gemini judge not working ([#152](https://github.com/langwatch/scenario/issues/152)) ([61bff5e](https://github.com/langwatch/scenario/commit/61bff5ef124886bf83309ac0bb7f8358a790f364))


### Documentation

* add other python examples ([#148](https://github.com/langwatch/scenario/issues/148)) ([253bb35](https://github.com/langwatch/scenario/commit/253bb35f0b744ab203cdb92eb03fe5bf8603d456))

## [0.7.13](https://github.com/langwatch/scenario/compare/python/v0.7.12...python/v0.7.13) (2025-10-09)


### Bug Fixes

* extra params bug ([#143](https://github.com/langwatch/scenario/issues/143)) ([d9fb441](https://github.com/langwatch/scenario/commit/d9fb441e5bb3d9bff9bbda44c4e258e552e01c15))
* update mocking examples ([#133](https://github.com/langwatch/scenario/issues/133)) ([95cb4e0](https://github.com/langwatch/scenario/commit/95cb4e09ff4a8b8ac895486a9f0f0f4345771054))


### Miscellaneous

* add black box testing examples ([#137](https://github.com/langwatch/scenario/issues/137)) ([87fec91](https://github.com/langwatch/scenario/commit/87fec9114b17f5c4b27f054e7adc074de8b761f3))

## [0.7.12](https://github.com/langwatch/scenario/compare/python/v0.7.11...python/v0.7.12) (2025-10-08)


### Features

* allow extras for model config ([#138](https://github.com/langwatch/scenario/issues/138)) ([3f23415](https://github.com/langwatch/scenario/commit/3f2341574ccfe05f9b18e5110fcea9a1817033e5))

## [0.7.11](https://github.com/langwatch/scenario/compare/python/v0.7.10...python/v0.7.11) (2025-09-15)


### Bug Fixes

* not opening browser window if ScenarioConfig() was not used before ([7175537](https://github.com/langwatch/scenario/commit/71755372157a439a9b120f988d61c284ab5cb821))

## [0.7.10](https://github.com/langwatch/scenario/compare/python/v0.7.9...python/v0.7.10) (2025-09-05)


### Features

* add langwatch tracing for scenarios python ([#129](https://github.com/langwatch/scenario/issues/129)) ([a349c83](https://github.com/langwatch/scenario/commit/a349c83792140b6fc2e81518fb9567350701b1a4))

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
