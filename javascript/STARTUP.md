# Package startup

Scenario keeps its full root API, including voice, red-team agents, evaluators,
tracing and the default `scenario` object. Node telemetry initialization and
browser launching load their implementation when called. Tracing setup remains
synchronous; the first scenario run still initializes tracing automatically.
Execution imports `getLangWatchTracer` from `langwatch/observability`, avoiding
the unrelated client and CLI exports in the SDK's root entry point.

This continues the ElevenLabs lazy-loading and optional-peer work in
[PR #933](https://github.com/langwatch/scenario/pull/933) and
[PR #945](https://github.com/langwatch/scenario/pull/945). No dependency becomes
optional in this change: automatic tracing and bundled audio remain available.

## Measure

After `pnpm build`, run `pnpm benchmark:startup`. An optional entry path and
sample count can compare another built version:

```sh
node scripts/startup.mjs /path/to/baseline/dist/index.js 7
```

Each sample uses a fresh Node process. The report measures synchronous CJS
import duration, added resident memory and the CommonJS module-cache count.
It excludes process launch time and does not measure the whole LangWatch app's
boot or the first scenario run. Filesystem caches and machine load affect timing.

On Node 24.21.0, seven local samples per version gave these medians:

| Measurement | Main (`ad220e6a`) | Optimized |
| --- | ---: | ---: |
| Import | 1,286 ms | 683 ms |
| Added RSS | 89.7 MiB | 62.4 MiB |
| Loaded CJS modules | 1,172 | 743 |

The published declarations and all 104 root export names remain unchanged.
`pnpm smoke:dist` checks both published formats in fresh processes: heavy
startup imports remain absent, text and voice factories are exposed, real
tracing records spans immediately after setup, and repeated setup does not
register the supplied processor twice. CI already runs this command.

RxJS and Zod remain substantial parts of the eager graph. Bundling private
copies would risk changing public class/schema identity; further work should
measure specific supported entry points rather than remove those APIs.
