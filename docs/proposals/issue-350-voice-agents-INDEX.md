# Issue #350 — Voice Agents Proposal Index

Navigation map for `issue-350-voice-agents-source.md` (1346 lines, ~12k tokens).

**Use this file to find the right section, then `Read(offset=X, limit=Y)` the source directly.** Do not read the full source unless genuinely needed. Do not create a summary — the source is authoritative.

## Top-level sections

| # | Section | Lines | What's in it |
|---|---|---|---|
| 1 | Vision & Philosophy | 5–38 | Core thesis: voice uses same `scenario.run()`, not a separate paradigm. Read this first. |
| 2 | What Voice Testing Is Actually For | 39–71 | Test-via-voice vs test-via-text decision table. Value proposition. |
| 3 | Architecture | 72–127 | How voice fits existing Scenario. What's unchanged vs extended. |
| 4 | **Core API** | 128–657 | Full API surface. The load-bearing section. |
| 5 | **Integration Guide by Platform** | 658–871 | 7 platforms with concrete connection patterns. Includes in-process/white-box Pipecat. |
| 6 | **Full Example Tests** | 872–1117 | 8 end-to-end examples. Includes callable-as-script-step pattern (Ex 6.5). |
| 7 | Design Decisions & Alternatives | 1118–1226 | Design choices with rationale. **Not "rejected" — these are the chosen designs.** |
| 8 | Real-World Pain Points | 1227–1272 | 5 failure patterns → judge criteria. AC source material. |
| 9 | TypeScript API Parity | 1273–1304 | Mirror-in-camelCase. Follow-up issue scope. |
| 10 | Implementation Phases | 1305–1346 | 5 phases. Planning structure. |

## §4 Core API — subsections

| # | Subsection | Lines |
|---|---|---|
| 4.1 | Voice Agent Adapters (Pipecat/LiveKit/Twilio/ElevenLabs/Vapi/OpenAIRealtime/Gemini/WebSocket/WebRTC) | 130–243 |
| 4.2 | Voice-Enabled User Simulator (`voice=`, personas, per-step overrides) | 244–306 |
| 4.3 | Voice-Enabled Judge (audio auto-detect, transcripts, timeline, traces) | 307–364 |
| 4.4 | Script Extensions (`agent(wait=False)`, `sleep`, `silence`, `dtmf`, `audio`, `interrupt`, `InterruptionConfig`) | 365–494 |
| 4.5 | Audio Effects & Simulation (13 effects + custom) | 495–559 |
| 4.6 | Results & Output (`VoiceRecording`, `VoiceEvent`, `LatencyMetrics`) | 560–627 |
| 4.7 | Real-time Monitoring | 628–657 |

## §5 Platform Integration — subsections

| # | Platform | Lines |
|---|---|---|
| 5.1 | Pipecat (WebSocket + WebRTC) | 660–712 |
| 5.2 | LiveKit | 713–732 |
| 5.3 | Twilio (real phone) | 733–759 |
| 5.4 | ElevenLabs Conversational AI | 760–777 |
| 5.5 | Vapi | 778–794 |
| 5.6 | OpenAI Realtime / Gemini Live | 795–828 |
| 5.7 | Custom HTTP/WebSocket | 829–871 |

## §6 Full Example Tests — subsections

| # | Example | Lines | Notable |
|---|---|---|---|
| 6.1 | Basic voice conversation | 874–900 | |
| 6.2 | Interruption handling | 901–930 | |
| 6.3 | Angry customer + background noise | 931–968 | |
| 6.4 | DTMF phone tree navigation | 969–997 | |
| 6.5 | Tool call verification | 998–1029 | **Callable as script step** (plain Python fn in `script=[]`) |
| 6.6 | Pre-recorded audio injection | 1030–1056 | |
| 6.7 | Random interruptions with `proceed()` | 1057–1086 | |
| 6.8 | Silence handling | 1087–1117 | |

## §7 Design Decisions — subsections

| # | Decision | Lines |
|---|---|---|
| 7.1 | Turn-based vs streaming model (turn-based chosen) | 1120–1148 |
| 7.2 | TTS user simulator vs realtime model (TTS chosen as default; realtime available via `role=AgentRole.USER`) | 1149–1174 |
| 7.3 | Per-platform classes vs unified `VoiceAgent(transport=...)` (per-platform chosen) | 1175–1187 |
| 7.4 | Script interruption API (declarative `interrupt()` + low-level `agent(wait=False)`) | 1188–1201 |
| 7.5 | Judge audio analysis approach (multimodal LLM; dedicated emotion models rejected) | 1202–1226 |

## How to use this index

- **Planning a feature:** locate section → `Read(offset=L, limit=N)` → work from source text.
- **Writing ACs:** §8 for pain-pattern ACs, §6 for API-surface ACs, §4 for contract ACs.
- **Checking "is X in scope":** §7 (design decisions) or §1 (philosophy). Don't assume — read.
- **Adding new artifacts:** don't create derivative summaries. Update this index if sections move.
