/**
 * judge — `AdherenceJudge`, the `AgentAdapter` (role = JUDGE) seam that plugs the
 * strong-model adherence scorer into `scenario.run(...)`.
 *
 * Seam pattern per `tests/custom-judge-with-traces.test.ts:21-57`: a custom judge
 * subclasses `AgentAdapter`, sets `role = AgentRole.JUDGE`, and in `call` returns
 * `null` to keep observing or a `JudgeResult` to render a verdict. Unlike that
 * example (which greps OTel spans), this judge reads the PRIMARY substrate — the
 * tee'd `stream-json` stdout on disk — because that is where intact
 * `tool_use`/`tool_result` records live (the on-disk flat JSONL may be an
 * `ai-title` stub on claude 2.1.207). The heavy lifting lives in framework-free
 * `judge-core.ts`; this file only adapts I/O.
 *
 * The DENOMINATOR (applicable set), corpus, and chains are configured on the
 * instance at construction — they are AUTHORED, never judge-decided. The full
 * per-procedure {@link AdherenceReport} is exposed as `lastReport` for the
 * harness (the scenario `JudgeResult` shape is coarser than what we measure).
 */

import { AgentAdapter, AgentRole, type AgentInput, type AgentReturnTypes } from "@langwatch/scenario";

import type {
  AdherenceReport,
  Chain,
  CorpusIndex,
  NormalizedTurn,
  Strategy,
} from "./types.ts";
import { scoreAdherence } from "./judge-core.ts";
import { normalizeTurns } from "./normalize.ts";
import { readSubstrate } from "./tee-substrate.ts";
import { readHookLog, collectCompiledSheetIds } from "./instrument.ts";
import type { FloorOpts } from "./run-shape-floor.ts";

export interface AdherenceJudgeConfig {
  /** AUTHORED applicable procedure ids (the denominator). */
  applicable: string[];
  /** Procedure bodies the judge reads. */
  corpus: CorpusIndex;
  chains?: Chain[];
  strategy?: Strategy;
  /** Static override/seed (fixtures). Merged with `hookLogPath`-derived ids, if both given. */
  compiledSheetIds?: string[];
  /**
   * Path to the H1 hook-events log (`sandbox.hookLog`). Read FRESH at judgment
   * time (like `workDir`) and unioned into `compiledSheetIds` — this is how a
   * live/finalize run learns which procedures the H1 sheet surfaced (#784
   * H1-attribution fix; the sheet never appears in the tee'd substrate itself).
   */
  hookLogPath?: string;
  /** Directory the tee wrote `<turn>.stream.jsonl` into — the PRIMARY substrate. */
  workDir?: string;
  /** Pre-normalized turns (overrides `workDir`; used by fixtures/tests). */
  turns?: NormalizedTurn[];
  model?: string;
  credentialsPath?: string;
  openaiApiKey?: string;
  floor?: FloorOpts | false;
  logger?: (msg: string) => void;
  /**
   * Injectable model function (overrides the default provider routing). The
   * live harness passes a Sonnet-primary / OpenAI-failover llm here so a
   * throttled Max bucket cannot strand the verdict; fixtures pass an oracle.
   */
  llm?: (system: string, user: string, model: string) => Promise<string>;
}

export class AdherenceJudge extends AgentAdapter {
  role: AgentRole = AgentRole.JUDGE;
  name = "AdherenceJudge";

  /** The most recent full report — richer than the returned JudgeResult. */
  lastReport?: AdherenceReport;

  constructor(private readonly config: AdherenceJudgeConfig) {
    super();
  }

  /** Resolve the substrate turns: explicit turns > tee'd substrate > input messages. */
  private resolveTurns(input: AgentInput): NormalizedTurn[] {
    if (this.config.turns) return this.config.turns;
    if (this.config.workDir) return readSubstrate(this.config.workDir);
    // Last-resort fallback: normalize the scenario's own message list. The
    // substrate path is strongly preferred (it keeps tool_use/tool_result intact).
    return normalizeTurns(
      input.messages.map((m) => ({
        type: m.role === "assistant" ? "assistant" : "user",
        message: { role: m.role, content: m.content as unknown },
      })),
    );
  }

  /**
   * Union of the static `compiledSheetIds` (fixtures) with whatever the H1 hook
   * log (`hookLogPath`) has accumulated so far — read FRESH each call, same as
   * `resolveTurns` reads the substrate fresh, so a live judgment sees every
   * compile event the run has fired up to that point.
   */
  private resolveCompiledSheetIds(): string[] {
    const fromConfig = this.config.compiledSheetIds ?? [];
    if (!this.config.hookLogPath) return fromConfig;
    const fromLog = collectCompiledSheetIds(readHookLog(this.config.hookLogPath));
    return [...new Set([...fromConfig, ...fromLog])];
  }

  async call(input: AgentInput): Promise<AgentReturnTypes> {
    if (!input.judgmentRequest) return null; // keep observing

    const turns = this.resolveTurns(input);
    const report = await scoreAdherence({
      turns,
      applicable: this.config.applicable,
      corpus: this.config.corpus,
      chains: this.config.chains,
      strategy: this.config.strategy,
      compiledSheetIds: this.resolveCompiledSheetIds(),
      model: this.config.model,
      credentialsPath: this.config.credentialsPath,
      openaiApiKey: this.config.openaiApiKey,
      floor: this.config.floor,
      logger: this.config.logger,
      llm: this.config.llm,
    });
    this.lastReport = report;

    if (report.belowFloor) {
      return {
        success: false,
        reasoning:
          "Run excluded below the run-shape floor (degenerate/stub/aborted); not scored.",
        metCriteria: [],
        unmetCriteria: ["Run must meet the run-shape floor before adherence is scored"],
      };
    }

    const metCriteria = report.perProcedure
      .filter((p) => p.followed)
      .map((p) => `followed: ${p.id}`);
    const unmetCriteria = report.perProcedure
      .filter((p) => !p.followed)
      .map((p) => `not followed: ${p.id} (${p.attribution})`);

    return {
      success: report.adherenceRate === 1 && report.applicableCount > 0,
      reasoning: `Adherence ${report.followedCount}/${report.applicableCount} (rate ${report.adherenceRate.toFixed(
        2,
      )}). Attributions: ${report.perProcedure
        .filter((p) => !p.followed)
        .map((p) => `${p.id}=${p.attribution}`)
        .join(", ") || "none"}.`,
      metCriteria,
      unmetCriteria,
    };
  }
}
