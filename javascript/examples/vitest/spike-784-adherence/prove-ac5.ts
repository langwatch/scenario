/**
 * prove-ac5 — THE ballgame. Runs the strong-model AdherenceJudge over every
 * ground-truth fixture (0 CC sessions) and checks it EQUALS each fixture's
 * declared ground truth on BOTH `followed` AND `attribution`, plus:
 *   - >= 2 distinct attribution classes proven
 *   - the transitive-miss fixture scores chain=false
 *   - the thinking-only-no-action fixture scores followed=false
 *   - the run-shape floor EXCLUDES a deliberately below-shape input
 *
 * Judge model: Claude Sonnet via Claude Max OAuth (Messages API). No
 * ANTHROPIC_API_KEY on this box; the OAuth token is read fresh from
 * ~/.claude/.credentials.json. Override with ADHERENCE_JUDGE_MODEL.
 *
 * Run:  tsx prove-ac5.ts
 */

import { readFileSync } from "node:fs";

import { DEFAULT_JUDGE_MODEL, defaultCredsPath, scoreAdherence } from "./judge-core.ts";
import { normalizeTurns } from "./normalize.ts";
import { passesRunShapeFloor } from "./run-shape-floor.ts";
import { ALL_FIXTURES, BELOW_FLOOR_INPUT } from "./fixtures/index.ts";
import type { Attribution, ProcedureVerdict } from "./types.ts";

const MODEL = process.env.ADHERENCE_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;
const CREDS = defaultCredsPath();

/**
 * For an OpenAI judge model, ensure OPENAI_API_KEY is set. The key is loaded at
 * RUNTIME from a gitignored scenario `.env` (never committed here). Override the
 * source with ADHERENCE_OPENAI_ENV.
 */
function ensureOpenAIKey(): void {
  if (/^claude/.test(MODEL) || process.env.OPENAI_API_KEY) return;
  const envPath = process.env.ADHERENCE_OPENAI_ENV ?? "/home/ubuntu/langwatch-workspace/scenario-050-repro/.env";
  try {
    const line = readFileSync(envPath, "utf8").split("\n").find((l) => l.startsWith("OPENAI_API_KEY="));
    const key = line?.slice("OPENAI_API_KEY=".length).replace(/^["']|["']$/g, "").trim();
    if (key) process.env.OPENAI_API_KEY = key;
  } catch {
    /* leave unset — scoreAdherence will error clearly */
  }
}
/**
 * Offline oracle mode (ADHERENCE_OFFLINE=1): substitute an oracle for the model
 * that returns each fixture's ground-truth `followed` values. This validates the
 * DETERMINISTIC logic (surfaced/attribution/transitive/floor) at zero API cost,
 * isolating the live run to the one thing the real model must get right:
 * `followed`. NOT evidence for AC5 — the live run is.
 */
const OFFLINE = process.env.ADHERENCE_OFFLINE === "1";

/** Build an oracle llm that echoes a fixture's ground-truth followed values. */
function oracleFor(gt: Record<string, { followed: boolean }>): (s: string, u: string, m: string) => Promise<string> {
  return async () =>
    JSON.stringify({
      verdicts: Object.entries(gt).map(([id, g]) => ({ id, followed: g.followed, reasoning: "oracle" })),
    });
}

interface Row {
  fixture: string;
  proc: string;
  declFollowed: boolean;
  judgedFollowed: boolean;
  declAttr: Attribution;
  judgedAttr: Attribution;
  declChain?: boolean | null;
  judgedChain: boolean | null;
  match: boolean;
  reasoning: string;
}

function log(...a: unknown[]): void {
  console.log(...a);
}

async function main(): Promise<void> {
  if (!OFFLINE) ensureOpenAIKey();
  const auth = /^claude/.test(MODEL)
    ? `Claude Max OAuth; token read fresh from ${CREDS}`
    : `OpenAI key (loaded at runtime from a gitignored .env; not committed)`;
  log("================ AC5 — Judge accuracy on ground-truth fixtures ================");
  log(`judge model ......... ${OFFLINE ? "OFFLINE ORACLE (deterministic-logic check only, NOT AC5 evidence)" : MODEL}`);
  if (!OFFLINE) log(`auth ................ ${auth}`);
  log(`fixtures ............ ${ALL_FIXTURES.length}`);
  log("");

  const rows: Row[] = [];
  const attributionClasses = new Set<Attribution>();
  let fixturesFullyMatched = 0;

  for (const fx of ALL_FIXTURES) {
    process.stdout.write(`  judging ${fx.id} ... `);
    const turns = normalizeTurns(fx.messages);
    let report;
    try {
      report = await scoreAdherence({
        turns,
        applicable: fx.applicable,
        corpus: fx.corpus,
        chains: fx.chains,
        strategy: fx.strategy,
        compiledSheetIds: fx.compiledSheetIds,
        floor: fx.floor,
        model: MODEL,
        credentialsPath: CREDS,
        llm: OFFLINE ? oracleFor(fx.groundTruth) : undefined,
        logger: (m) => process.stdout.write(`\n     ${m}\n`),
      });
    } catch (e) {
      log(`ERROR: ${(e as Error).message}`);
      throw e;
    }

    const byId = new Map<string, ProcedureVerdict>(report.perProcedure.map((p) => [p.id, p]));
    let fixtureMatched = true;
    for (const procId of fx.applicable) {
      const gt = fx.groundTruth[procId];
      const v = byId.get(procId);
      const judgedFollowed = v?.followed ?? false;
      const judgedAttr = v?.attribution ?? "none";
      const judgedChain = v?.transitiveChainFollowed ?? null;
      if (!v?.followed) attributionClasses.add(judgedAttr);

      const followedOk = judgedFollowed === gt.followed;
      const attrOk = judgedAttr === gt.attribution;
      const chainOk = gt.transitiveChainFollowed === undefined ? true : judgedChain === gt.transitiveChainFollowed;
      const match = followedOk && attrOk && chainOk;
      if (!match) fixtureMatched = false;

      rows.push({
        fixture: fx.id,
        proc: procId,
        declFollowed: gt.followed,
        judgedFollowed,
        declAttr: gt.attribution,
        judgedAttr,
        declChain: gt.transitiveChainFollowed,
        judgedChain,
        match,
        reasoning: v?.reasoning ?? "(no verdict)",
      });
    }
    if (fixtureMatched) fixturesFullyMatched += 1;
    log(fixtureMatched ? "MATCH" : "MISMATCH");
  }

  // Per-fixture table.
  log("");
  log("---- per-procedure: declared vs judged ----");
  log(
    [
      "fixture".padEnd(30),
      "procedure".padEnd(18),
      "app".padEnd(4),
      "followed d/j".padEnd(14),
      "attribution d/j".padEnd(34),
      "chain d/j".padEnd(16),
      "OK",
    ].join(" "),
  );
  for (const r of rows) {
    log(
      [
        r.fixture.padEnd(30),
        r.proc.padEnd(18),
        "yes".padEnd(4),
        `${String(r.declFollowed)}/${String(r.judgedFollowed)}`.padEnd(14),
        `${r.declAttr} / ${r.judgedAttr}`.padEnd(34),
        `${chainStr(r.declChain)}/${chainStr(r.judgedChain)}`.padEnd(16),
        r.match ? "OK" : "XX",
      ].join(" "),
    );
  }

  // Mismatch diagnostics (judge reasoning) — for iterating the prompt.
  const misses = rows.filter((r) => !r.match);
  if (misses.length) {
    log("");
    log("---- MISMATCH diagnostics (judge reasoning) ----");
    for (const r of misses) {
      log(`  ${r.fixture} / ${r.proc}: declared followed=${r.declFollowed}, judged=${r.judgedFollowed}`);
      log(`     reasoning: ${r.reasoning}`);
    }
  }

  // Floor exclusion.
  log("");
  log("---- run-shape floor: below-shape input must be EXCLUDED ----");
  const bfTurns = normalizeTurns(BELOW_FLOOR_INPUT.messages);
  const floorRes = passesRunShapeFloor(bfTurns, BELOW_FLOOR_INPUT.floor);
  const bfReport = await scoreAdherence({
    turns: bfTurns,
    applicable: BELOW_FLOOR_INPUT.applicable,
    corpus: BELOW_FLOOR_INPUT.corpus,
    floor: BELOW_FLOOR_INPUT.floor,
    model: MODEL,
    credentialsPath: CREDS,
  });
  log(`  passesRunShapeFloor.ok = ${floorRes.ok}  reason: ${floorRes.reason ?? "(passes)"}`);
  log(`  scoreAdherence.belowFloor = ${bfReport.belowFloor === true}  (never sent to the model)`);
  const floorExcluded = floorRes.ok === false && bfReport.belowFloor === true;

  // Verdicts.
  const totalRows = rows.length;
  const matchedRows = rows.filter((r) => r.match).length;
  const allMatch = matchedRows === totalRows;
  const classesOk = attributionClasses.size >= 2;
  const transitiveFixtureOk = rows.some(
    (r) => r.fixture === "f2-transitive-miss" && r.proc === "deploy-service" && r.judgedChain === false && r.match,
  );
  const thinkingFixtureOk = rows.some(
    (r) => r.fixture === "f3-thinking-only-no-action" && r.judgedFollowed === false && r.match,
  );

  log("");
  log("================ AC5 verdict ================");
  log(`per-procedure matches ......... ${matchedRows}/${totalRows}                 ${allMatch ? "PASS" : "FAIL"}`);
  log(`fixtures fully matched ........ ${fixturesFullyMatched}/${ALL_FIXTURES.length}`);
  log(`distinct attribution classes .. ${attributionClasses.size} {${[...attributionClasses].join(", ")}} (>=2)  ${classesOk ? "PASS" : "FAIL"}`);
  log(`transitive-miss chain=false ... ${transitiveFixtureOk ? "PASS" : "FAIL"}`);
  log(`thinking-only followed=false .. ${thinkingFixtureOk ? "PASS" : "FAIL"}`);
  log(`floor excludes below-shape .... ${floorExcluded ? "PASS" : "FAIL"}`);
  const pass = allMatch && classesOk && transitiveFixtureOk && thinkingFixtureOk && floorExcluded;
  log("");
  log(`AC5 VERDICT: ${pass ? "PASS — judge equals ground truth on followed AND attribution (100%)" : "FAIL — see MISMATCH rows above"}`);
  process.exit(pass ? 0 : 1);
}

function chainStr(v: boolean | null | undefined): string {
  if (v === undefined) return "-";
  if (v === null) return "n/a";
  return String(v);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
