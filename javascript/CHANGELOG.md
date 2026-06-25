# Changelog

## [0.4.15](https://github.com/langwatch/scenario/compare/javascript/v0.4.14...javascript/v0.4.15) (2026-06-25)


### Bug Fixes

* **voice/#648:** terminal drain on non-audio completion (EL + WebSocket) ([#693](https://github.com/langwatch/scenario/issues/693)) ([c42320e](https://github.com/langwatch/scenario/commit/c42320e130ae3d0ea67a743ffea8195cc5f76825))

## [0.4.14](https://github.com/langwatch/scenario/compare/javascript/v0.4.13...javascript/v0.4.14) (2026-06-19)


### Features

* **#660:** expose context param on scenario.judge() public API ([#667](https://github.com/langwatch/scenario/issues/667)) ([900f3d8](https://github.com/langwatch/scenario/commit/900f3d866d5787a015780965e9de4f518b753ad7))
* **sdk:** add langwatch config to ScenarioConfig for race-condition-free multi-tenant runs ([#545](https://github.com/langwatch/scenario/issues/545)) ([eab72b3](https://github.com/langwatch/scenario/commit/eab72b369028ee269aeb036bce0b05f50988440e))


### Bug Fixes

* **#655:** replace brittle judge criteria with generic behavioral criteria in audio examples ([#679](https://github.com/langwatch/scenario/issues/679)) ([732d426](https://github.com/langwatch/scenario/commit/732d426ae4865c8027fb03182cf8211461c11514))
* **security:** bump hono &gt;=4.12.25 and ws &gt;=8.21.0 ([#684](https://github.com/langwatch/scenario/issues/684)) ([5050488](https://github.com/langwatch/scenario/commit/5050488d51ef2c79c043616c28f2e4d6c77aaa27))
* **voice/#661:** port sliding-idle-deadline to TypeScript receiveAudio ([#668](https://github.com/langwatch/scenario/issues/668)) ([c66ed6d](https://github.com/langwatch/scenario/commit/c66ed6d7a3db97de9fbf223db8a930122b292d78))
* **voice/ts:** explicit EL ConvAI turn-commit so scripted next-turn receive re-engages ([#596](https://github.com/langwatch/scenario/issues/596)) ([795ae8e](https://github.com/langwatch/scenario/commit/795ae8eb7e672e180fea6a657d472e566431883b))

## [0.4.13](https://github.com/langwatch/scenario/compare/javascript/v0.4.12...javascript/v0.4.13) (2026-06-11)


### Bug Fixes

* **deps:** close 16 npm security alerts in scenario examples ([#637](https://github.com/langwatch/scenario/issues/637)) ([ced16fe](https://github.com/langwatch/scenario/commit/ced16fee797723c49c4a67036065c7ddafc47eed))
* **deps:** close 25 npm security alerts in docs and the JS SDK ([#620](https://github.com/langwatch/scenario/issues/620)) ([ca91380](https://github.com/langwatch/scenario/commit/ca91380ff41430eb16bdfd31833453be40b047f9))
* **deps:** close CRITICAL shell-quote and uuid alerts in JS SDK ([#636](https://github.com/langwatch/scenario/issues/636)) ([abdc38f](https://github.com/langwatch/scenario/commit/abdc38f171762c41df1df353c617697c7afea188))
* **voice/#623:** reframe realtime agent audio turns so the voiced sim does not echo them ([#653](https://github.com/langwatch/scenario/issues/653)) ([9302877](https://github.com/langwatch/scenario/commit/9302877d9b98e6e5be25e85aee854151a958b28f))
* **voice/sdk/#451:** stop re-stringifying input_audio array in event-reporter ([#639](https://github.com/langwatch/scenario/issues/639)) ([d5188d3](https://github.com/langwatch/scenario/commit/d5188d369f979b7c8ddfe56e8268567ea99e99c3))
* **voice/sdk/#451:** stop re-stringifying input_audio array in event-reporter (see+listen) ([d5188d3](https://github.com/langwatch/scenario/commit/d5188d369f979b7c8ddfe56e8268567ea99e99c3))
* **voice+judge:** surface dropped model tool calls ([#630](https://github.com/langwatch/scenario/issues/630) + [#631](https://github.com/langwatch/scenario/issues/631)) ([#635](https://github.com/langwatch/scenario/issues/635)) ([de60f82](https://github.com/langwatch/scenario/commit/de60f82c2dadc20d2081bf4f3cbbd3c332442070))
* **voice:** hosted ElevenLabs single-exchange ceiling — docs + enriched timeout error ([#643](https://github.com/langwatch/scenario/issues/643)) ([aae16be](https://github.com/langwatch/scenario/commit/aae16beec4d5b74ee331c29ad960c43632434da0))
* **voice:** surface tool-only realtime turns (no audio chunk) ([#647](https://github.com/langwatch/scenario/issues/647)) ([6041447](https://github.com/langwatch/scenario/commit/6041447b1740646c6543e951096f00031dd825dc))


### Miscellaneous

* **deps/#608:** migrate elevenlabs@1.59.0 → @elevenlabs/elevenlabs-js ([#611](https://github.com/langwatch/scenario/issues/611)) ([6498df4](https://github.com/langwatch/scenario/commit/6498df44265f3f0cfc9a5262809ba65501d721db))
* **examples/voice/#486:** retire legacy gpt-4o-audio-preview surface, migrate supported audio examples to gpt-audio-mini ([#612](https://github.com/langwatch/scenario/issues/612)) ([1ebdd1c](https://github.com/langwatch/scenario/commit/1ebdd1ce2782c95cf2b41fcc16b405804b1f5a10))


### Documentation

* **voice/#606:** document STT/TTS model choices as deliberate current-gen ([#610](https://github.com/langwatch/scenario/issues/610)) ([6211df3](https://github.com/langwatch/scenario/commit/6211df3c1386520a59de165f5a7ccd57d6a8eaf2))


### Code Refactoring

* **#518:** move capability-matrix doc assertion to dedicated voice-docs suite ([#550](https://github.com/langwatch/scenario/issues/550)) ([68df34c](https://github.com/langwatch/scenario/commit/68df34c4b9fd55af890c0abae8fd439ccfaf859b)), closes [#518](https://github.com/langwatch/scenario/issues/518)

## [0.4.12](https://github.com/langwatch/scenario/compare/javascript/v0.4.11...javascript/v0.4.12) (2026-06-04)


### Features

* **#318:** add context param to JudgmentRequest for extra judge evaluation input ([#554](https://github.com/langwatch/scenario/issues/554)) ([1947824](https://github.com/langwatch/scenario/commit/1947824f179da1176664a843039ba8bd64e7a5fe))
* add GOAT strategy with dynamic technique selection for RedTeamAgent ([#346](https://github.com/langwatch/scenario/issues/346)) ([2896c97](https://github.com/langwatch/scenario/commit/2896c97e9a534a9ff1817904053a6af4f1ad06a4))
* **ci/#364:** add pr-auto-approve.yml as passive observer (PR [#1](https://github.com/langwatch/scenario/issues/1) of 4) ([#485](https://github.com/langwatch/scenario/issues/485)) ([4d84597](https://github.com/langwatch/scenario/commit/4d8459710e566ac90ad731164a4506f6d81365eb))
* **red-team:** zero-friction report dashboard — auto-save + `scenario redteam-report` CLI ([2896c97](https://github.com/langwatch/scenario/commit/2896c97e9a534a9ff1817904053a6af4f1ad06a4))
* **test/#516:** bind PR [#511](https://github.com/langwatch/scenario/issues/511) voice scenarios via vitest-cucumber (retrofit PR-A) ([#517](https://github.com/langwatch/scenario/issues/517)) ([c247f42](https://github.com/langwatch/scenario/commit/c247f42d4f8a1bfe5d4f4e86a55bd0ba32d4d650))
* **typescript-sdk/#372:** voice agent contract surface (types only, PR1 of N) ([#511](https://github.com/langwatch/scenario/issues/511)) ([9216d35](https://github.com/langwatch/scenario/commit/9216d35071bba29ba065f4b188d7c8199c34777f))
* **typescript-sdk:** voice agent testing — consolidated clean stack ([#561](https://github.com/langwatch/scenario/issues/561)) ([5847c4b](https://github.com/langwatch/scenario/commit/5847c4b40f76edefeca810ba40708db281b70821))


### Bug Fixes

* **deps:** bump fast-uri to &gt;=3.1.2 for high severity CVEs ([#450](https://github.com/langwatch/scenario/issues/450)) ([474ab65](https://github.com/langwatch/scenario/commit/474ab6503a044d4c80f30dd6bdf712988becd636))
* **deps:** bump fast-uri to &gt;=3.1.2 to resolve high severity vulnerabilities ([474ab65](https://github.com/langwatch/scenario/commit/474ab6503a044d4c80f30dd6bdf712988becd636))
* **deps:** bump liquidjs override to &gt;=10.26.0 to close RCE/ReDoS alerts ([#591](https://github.com/langwatch/scenario/issues/591)) ([daaf9cc](https://github.com/langwatch/scenario/commit/daaf9ccfc4f89609518094a9a390eaaa89972fc3))
* **deps:** bump protobufjs to &gt;=7.5.6/&gt;=8.0.2 for high severity CVEs ([#463](https://github.com/langwatch/scenario/issues/463)) ([f008161](https://github.com/langwatch/scenario/commit/f008161c8f45192a0290f0ebb884cc830de855bd))
* **deps:** bump protobufjs to &gt;=8.0.2 for 4 high severity CVEs ([#462](https://github.com/langwatch/scenario/issues/462)) ([e2c0499](https://github.com/langwatch/scenario/commit/e2c04991e352a777a1adc9e7719c6b69ceab682b))
* **deps:** override hono to &gt;=4.12.18 for JWT NumericDate validation CVE ([#477](https://github.com/langwatch/scenario/issues/477)) ([d81ff1a](https://github.com/langwatch/scenario/commit/d81ff1ac031d3a4b62cfc28d5acd7e265cde4395))
* **deps:** override langsmith to &gt;=0.6.0 for CVE fix ([#471](https://github.com/langwatch/scenario/issues/471)) ([4e5237e](https://github.com/langwatch/scenario/commit/4e5237ef3b966e9341ffe635454b938adea7e3ab))
* **deps:** override langsmith to &gt;=0.6.0 for prompt deserialization CVEs ([4e5237e](https://github.com/langwatch/scenario/commit/4e5237ef3b966e9341ffe635454b938adea7e3ab))
* **deps:** override minimatch to &gt;=9.0.6 (CVE-2026-26996) ([#395](https://github.com/langwatch/scenario/issues/395)) ([ceb0b59](https://github.com/langwatch/scenario/commit/ceb0b59e6a96fe27adf865f03aa1de8a9ea03357))
* **deps:** override qs to &gt;=6.14.2 for arrayLimit bypass DoS CVE ([#482](https://github.com/langwatch/scenario/issues/482)) ([51a2b6d](https://github.com/langwatch/scenario/commit/51a2b6daaf5c243154c3c61b8ffeaafd368d5628))
* **deps:** resolve 4 high-severity Dependabot security alerts ([#393](https://github.com/langwatch/scenario/issues/393)) ([97f257d](https://github.com/langwatch/scenario/commit/97f257ddc30a6bd7a9cca65e2e62e0ed0c688085))
* **examples:** stabilize custom LLM judge criteria matching ([#396](https://github.com/langwatch/scenario/issues/396)) ([f4b536c](https://github.com/langwatch/scenario/commit/f4b536cf12a6d525b487c672f9451390e13957c7))
* **examples:** use positional index matching in custom judge examples ([f4b536c](https://github.com/langwatch/scenario/commit/f4b536cf12a6d525b487c672f9451390e13957c7))
* **judge:** harden forceVerdict so discovery tools cannot leak (JS + Python) ([#377](https://github.com/langwatch/scenario/issues/377)) ([0e2859f](https://github.com/langwatch/scenario/commit/0e2859f5ec1c171fa3d3d6f89b7d59555be6b95b))
* **red-team:** annotate H_attacker when post-hoc injection fires ([#326](https://github.com/langwatch/scenario/issues/326), [#334](https://github.com/langwatch/scenario/issues/334)) ([2896c97](https://github.com/langwatch/scenario/commit/2896c97e9a534a9ff1817904053a6af4f1ad06a4))
* **security:** bump liquidjs override to fix memoryLimit bypass, memory amplification, and DoS CVEs ([25ba99d](https://github.com/langwatch/scenario/commit/25ba99ddf5bcfdc903ef59dd59e1606d8417f20c))
* **security:** bump liquidjs to fix 4 additional high-severity CVEs ([#412](https://github.com/langwatch/scenario/issues/412)) ([25ba99d](https://github.com/langwatch/scenario/commit/25ba99ddf5bcfdc903ef59dd59e1606d8417f20c))
* **security:** delete orphaned vitest lockfile recreated during rebase ([ea8a19c](https://github.com/langwatch/scenario/commit/ea8a19cfdd1ff02ae3c9f7839d17ad5bf9346a5d))
* **security:** delete orphaned vitest lockfile to fix 8 Dependabot alerts ([#426](https://github.com/langwatch/scenario/issues/426)) ([ea8a19c](https://github.com/langwatch/scenario/commit/ea8a19cfdd1ff02ae3c9f7839d17ad5bf9346a5d))
* **security:** patch @modelcontextprotocol/sdk ReDoS, DNS rebinding, and data leak ([#410](https://github.com/langwatch/scenario/issues/410)) ([b993066](https://github.com/langwatch/scenario/commit/b9930668175f8adbeb0941d721fa45b171c24810))
* **security:** patch @modelcontextprotocol/sdk ReDoS, DNS rebinding, and data leak CVEs ([b993066](https://github.com/langwatch/scenario/commit/b9930668175f8adbeb0941d721fa45b171c24810))
* **security:** patch critical CVEs in protobufjs and handlebars ([#390](https://github.com/langwatch/scenario/issues/390)) ([de89d50](https://github.com/langwatch/scenario/commit/de89d5017cf27dd3c060bdafe920ed0168eff831))
* **security:** patch critical vulnerabilities in protobufjs and handlebars ([de89d50](https://github.com/langwatch/scenario/commit/de89d5017cf27dd3c060bdafe920ed0168eff831))
* **security:** patch CVE-2026-27903 in minimatch ([#398](https://github.com/langwatch/scenario/issues/398)) ([b61cc60](https://github.com/langwatch/scenario/commit/b61cc6005645b7703788c02c6cb4d134559e339b))
* **security:** patch flatted prototype pollution via parse() ([#421](https://github.com/langwatch/scenario/issues/421)) ([3a20e6c](https://github.com/langwatch/scenario/commit/3a20e6c57bb81583144cb643d3fcac390f66af3b))
* **security:** patch langchain serialization injection vulnerability ([#420](https://github.com/langwatch/scenario/issues/420)) ([89dd094](https://github.com/langwatch/scenario/commit/89dd0947dd660bb8aefe243c803841b65cbb67a1))
* **security:** patch path-to-regexp DoS in openai-realtime-demo ([c6e55b0](https://github.com/langwatch/scenario/commit/c6e55b06ba4bcdfa7640fffae9f086d3a871245c))
* **security:** patch path-to-regexp DoS in openai-realtime-demo (CVE-2026-4926) ([#428](https://github.com/langwatch/scenario/issues/428)) ([c6e55b0](https://github.com/langwatch/scenario/commit/c6e55b06ba4bcdfa7640fffae9f086d3a871245c))
* **security:** patch path-to-regexp DoS via sequential optional groups ([#416](https://github.com/langwatch/scenario/issues/416)) ([752539a](https://github.com/langwatch/scenario/commit/752539a738993f3b03085cda54b04792a036f17d))
* **security:** patch rollup arbitrary file write via path traversal ([#399](https://github.com/langwatch/scenario/issues/399)) ([55a0259](https://github.com/langwatch/scenario/commit/55a02598ad8d245dfac159357b17c8d89192b824))
* **security:** patch rollup path traversal CVE (&gt;= 4.0.0, &lt; 4.59.0) ([55a0259](https://github.com/langwatch/scenario/commit/55a02598ad8d245dfac159357b17c8d89192b824))
* **security:** patch trim-newlines uncontrolled resource consumption ([#415](https://github.com/langwatch/scenario/issues/415)) ([1c507c3](https://github.com/langwatch/scenario/commit/1c507c35364a229ba72b80b380a6f5fac46431b7))
* **security:** patch vite server.fs.deny bypass and WebSocket file read CVEs ([#419](https://github.com/langwatch/scenario/issues/419)) ([7bb7af9](https://github.com/langwatch/scenario/commit/7bb7af95445a4b80a1daf6a4bfa9866099c2fc50))
* **security:** upgrade picomatch, @hono/node-server, and glob to fix CVEs ([#394](https://github.com/langwatch/scenario/issues/394)) ([4395e52](https://github.com/langwatch/scenario/commit/4395e52f765895a8c58def12086cb09e179e8a18))


### Miscellaneous

* **deps:** bump @ungap/structured-clone past 1.3.1 (CWE-502) ([#544](https://github.com/langwatch/scenario/issues/544)) ([f716e46](https://github.com/langwatch/scenario/commit/f716e46b7f7f62ab61f5f99a761ea566985e891f))
* **deps:** bump pnpm/action-setup from 2.4.1 to 5.0.0 ([#300](https://github.com/langwatch/scenario/issues/300)) ([053cc3a](https://github.com/langwatch/scenario/commit/053cc3a7cb192f725fe2c64beddeb996493c122d))
* **deps:** remove unused nanoid-cli devDep from vitest examples ([#422](https://github.com/langwatch/scenario/issues/422)) ([d4a40a5](https://github.com/langwatch/scenario/commit/d4a40a5871239ee5440bb007cb5a32e9eab5df0e))
* main-side cleanup — docs + spec + python/TS parity ([#586](https://github.com/langwatch/scenario/issues/586)) ([371f94c](https://github.com/langwatch/scenario/commit/371f94cd20998004398fa19d663254cb9aace8d8))
* **tests:** remove flaky 10-turn travel-planning example test ([#423](https://github.com/langwatch/scenario/issues/423)) ([bbe86de](https://github.com/langwatch/scenario/commit/bbe86de991124e9cfe64d103c107795f9ff0ae3c))
* **tests:** remove flaky live-LLM travel-agent example test ([ac911ff](https://github.com/langwatch/scenario/commit/ac911ff2da99de1ae0f8341e6702cb96c448db54))
* **tests:** remove flaky travel-agent example test ([#425](https://github.com/langwatch/scenario/issues/425)) ([ac911ff](https://github.com/langwatch/scenario/commit/ac911ff2da99de1ae0f8341e6702cb96c448db54))
* **tests:** remove no-op example tests + audit notes ([#424](https://github.com/langwatch/scenario/issues/424)) ([947f219](https://github.com/langwatch/scenario/commit/947f219344e9beb6267f8a6d43e9b01717284da2))
* **tests:** remove no-op example tests that always pass or are skipped ([947f219](https://github.com/langwatch/scenario/commit/947f219344e9beb6267f8a6d43e9b01717284da2))


### Code Refactoring

* **test/#522:** move instanceof assertions from Given to Then in voice contract surface ([#559](https://github.com/langwatch/scenario/issues/559)) ([c8cca4e](https://github.com/langwatch/scenario/commit/c8cca4ecafb0ebfb10d2d39b36ac2fe28443a376))

## [0.4.11](https://github.com/langwatch/scenario/compare/javascript/v0.4.10...javascript/v0.4.11) (2026-04-23)


### Features

* add GOAT strategy with dynamic technique selection for RedTeamAgent ([#306](https://github.com/langwatch/scenario/issues/306)) ([e62c292](https://github.com/langwatch/scenario/commit/e62c292dbb46bbc6a7afd312604746541b02e84f))


### Miscellaneous

* relicense from AGPLv3 to Apache 2.0 ([66ad733](https://github.com/langwatch/scenario/commit/66ad73312c805c320232059635bab5cbc3c75be1))
* relicense to Apache 2.0 ([#378](https://github.com/langwatch/scenario/issues/378)) ([66ad733](https://github.com/langwatch/scenario/commit/66ad73312c805c320232059635bab5cbc3c75be1))

## [0.4.10](https://github.com/langwatch/scenario/compare/javascript/v0.4.9...javascript/v0.4.10) (2026-04-10)


### Bug Fixes

* default scenarioSetId to 'default' for all events ([#305](https://github.com/langwatch/scenario/issues/305)) ([7bbc8c6](https://github.com/langwatch/scenario/commit/7bbc8c63137f920f880d4bd099516e745aa7e386))
* default scenarioSetId to "default" when not provided ([7bbc8c6](https://github.com/langwatch/scenario/commit/7bbc8c63137f920f880d4bd099516e745aa7e386)), closes [#304](https://github.com/langwatch/scenario/issues/304)
* force verdict on judge discovery exhaustion instead of hard-failing ([#315](https://github.com/langwatch/scenario/issues/315)) ([197f567](https://github.com/langwatch/scenario/commit/197f5673cfa4147c10b368ae095842b043026d8c))
* judge off-by-one, auto-run on script exhaustion, assertion criteria, marathon_script cleanup ([#289](https://github.com/langwatch/scenario/issues/289)) ([91f76d1](https://github.com/langwatch/scenario/commit/91f76d128a5d8c0cbe5c6b00337f279b4890ea57))
* revert audio model and reduce multilingual test turns ([#314](https://github.com/langwatch/scenario/issues/314)) ([177cdb6](https://github.com/langwatch/scenario/commit/177cdb65c32a36263be98f3c38ff7d573cf4e3f6))
* revert audio model to gpt-4o-audio-preview and reduce multilingual test turns ([177cdb6](https://github.com/langwatch/scenario/commit/177cdb65c32a36263be98f3c38ff7d573cf4e3f6))


### Miscellaneous

* use gpt-5-mini everywhere, enable telemetry, fix reasoning model compat ([#311](https://github.com/langwatch/scenario/issues/311)) ([2384fb2](https://github.com/langwatch/scenario/commit/2384fb263d35b7220b5ee4cbe8291295a0500ab8))

## [0.4.9](https://github.com/langwatch/scenario/compare/javascript/v0.4.8...javascript/v0.4.9) (2026-03-22)


### Features

* add scenario role and run_id attributes to agent spans ([#294](https://github.com/langwatch/scenario/issues/294)) ([d7e31cc](https://github.com/langwatch/scenario/commit/d7e31cc2db91be9594bec0c4c111ed9e7ddf5fe0))

## [0.4.8](https://github.com/langwatch/scenario/compare/javascript/v0.4.7...javascript/v0.4.8) (2026-03-13)


### Features

* dual conversation histories for RedTeamAgent ([#282](https://github.com/langwatch/scenario/issues/282)) ([fa45876](https://github.com/langwatch/scenario/commit/fa458760e73ac03061a7210b43f2bc0e1602be70))
* support optional runId in RunOptions ([#284](https://github.com/langwatch/scenario/issues/284)) ([d5fd769](https://github.com/langwatch/scenario/commit/d5fd769a98e3bbc6fe03448af361c4fd35387baa))

## [0.4.7](https://github.com/langwatch/scenario/compare/javascript/v0.4.6...javascript/v0.4.7) (2026-03-10)


### Features

* add backtracking on hard refusals for RedTeamAgent (TypeScript) ([#271](https://github.com/langwatch/scenario/issues/271)) ([79157cd](https://github.com/langwatch/scenario/commit/79157cdf340b5f99e07935a308ff49a3b84f8fca))
* backtracking on hard refusals for RedTeamAgent ([#270](https://github.com/langwatch/scenario/issues/270)) ([62190a0](https://github.com/langwatch/scenario/commit/62190a0bd8dcf1314a148f25b60c8816af95561b))


### Bug Fixes

* align red teaming nomenclature between TypeScript and Python ([62190a0](https://github.com/langwatch/scenario/commit/62190a0bd8dcf1314a148f25b60c8816af95561b))
* resolve CI test failures blocking JS publish ([#275](https://github.com/langwatch/scenario/issues/275)) ([049a13b](https://github.com/langwatch/scenario/commit/049a13b7ae03e5985dc01d64ebd1b1c37999dfba))

## [0.4.6](https://github.com/langwatch/scenario/compare/javascript/v0.4.5...javascript/v0.4.6) (2026-03-07)


### Features

* add langwatch.origin="simulation" span attribute ([#264](https://github.com/langwatch/scenario/issues/264)) ([30fbdf0](https://github.com/langwatch/scenario/commit/30fbdf006c688ce43db1ad61e678fb0e28578266))


### Bug Fixes

* add timeout to EventBus.drain() to prevent test hangs ([#261](https://github.com/langwatch/scenario/issues/261)) ([2353f35](https://github.com/langwatch/scenario/commit/2353f35d41a13d5c172f3538d6e5e02894a13797))


### Miscellaneous

* change license from MIT to AGPLv3 ([#258](https://github.com/langwatch/scenario/issues/258)) ([d3ac921](https://github.com/langwatch/scenario/commit/d3ac9213c0a1406aab630c3a034b2dcbb2166976))

## [0.4.5](https://github.com/langwatch/scenario/compare/javascript/v0.4.4...javascript/v0.4.5) (2026-03-05)


### Features

* progressive trace discovery for Python SDK + span ID improvements (both languages) ([#242](https://github.com/langwatch/scenario/issues/242)) ([716c8b7](https://github.com/langwatch/scenario/commit/716c8b71215f12e8548f642e4e99c9c8054d1e72))


### Bug Fixes

* allow judge discovery tools before forced verdict on large traces ([#251](https://github.com/langwatch/scenario/issues/251)) ([3c32b01](https://github.com/langwatch/scenario/commit/3c32b0181d550e363d42438051bd48b8e4dd7880))

## [0.4.4](https://github.com/langwatch/scenario/compare/javascript/v0.4.3...javascript/v0.4.4) (2026-02-27)


### Features

* progressive trace discovery for large OTEL traces ([#240](https://github.com/langwatch/scenario/issues/240)) ([8d4d058](https://github.com/langwatch/scenario/commit/8d4d058d30fdcc4e2da62851d64ccd4bbbcaf194))

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
