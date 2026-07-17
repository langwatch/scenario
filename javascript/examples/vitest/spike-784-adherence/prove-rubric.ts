/**
 * prove-rubric — THE proof for the RUBRIC judge (the improvised/rubric variant's
 * core new piece), the analogue of prove-ac5 for the action judge. Runs the
 * OUTPUT-QUALITY judge (rubric-core `scoreRubric`) over every ground-truth artifact
 * fixture (0 Max bucket) and checks it reproduces each fixture's declared
 * per-criterion ground truth AND the pass/fail label, plus:
 *   - a STRONG artifact scores high (>= threshold) and a VAGUE / CONFABULATED one
 *     scores low (< threshold) — the discrimination the variant depends on;
 *   - a CONFIDENT-but-WRONG artifact (confabulated) scores low DESPITE its
 *     confident tone — proof the judge grades substance, not fluency;
 *   - a BOUNDARY artifact (right cause + evidence, no concrete fix) lands at exactly
 *     threshold — proof the criteria discriminate, not just "long text = pass";
 *   - the empty-artifact short-circuit scores 0 without calling the model.
 *
 * Judge model: OpenAI `gpt-5.1` ONLY (asserted non-Anthropic — the subject is
 * Claude, so an Anthropic judge would grade its own family). The key is loaded at
 * RUNTIME from a gitignored scenario .env (never committed). Override the model with
 * ADHERENCE_RUBRIC_MODEL, the env source with ADHERENCE_OPENAI_ENV.
 *
 * Run:  tsx prove-rubric.ts
 *       RUBRIC_OFFLINE=1 tsx prove-rubric.ts   # deterministic-logic check (oracle; NOT proof)
 */

import { readFileSync } from "node:fs";

import { DEFAULT_RUBRIC_MODEL, scoreRubric, type RubricResult } from "./rubric-core.ts";
import { RCA_RUBRIC, proveSourceMaterial } from "./prove-world.ts";
import { RUBRIC_FIXTURES, type RubricFixture } from "./fixtures/rubric-fixtures.ts";

const MODEL = process.env.ADHERENCE_RUBRIC_MODEL ?? DEFAULT_RUBRIC_MODEL;
const OFFLINE = process.env.RUBRIC_OFFLINE === "1";

function log(...a: unknown[]): void {
  console.log(...a);
}

/** Load OPENAI_API_KEY at runtime from a gitignored scenario .env (never committed here). */
function ensureOpenAIKey(): void {
  if (process.env.OPENAI_API_KEY) return;
  const envPath = process.env.ADHERENCE_OPENAI_ENV ?? "/home/ubuntu/langwatch-workspace/scenario-050-repro/.env";
  try {
    const line = readFileSync(envPath, "utf8").split("\n").find((l) => l.startsWith("OPENAI_API_KEY="));
    const key = line?.slice("OPENAI_API_KEY=".length).replace(/^["']|["']$/g, "").trim();
    if (key) process.env.OPENAI_API_KEY = key;
  } catch {
    /* leave unset — scoreRubric will error clearly */
  }
}

/** Oracle llm (offline): echo a fixture's declared per-criterion ground truth. */
function oracleFor(fx: RubricFixture): (s: string, u: string, m: string) => Promise<string> {
  return async () =>
    JSON.stringify({
      criteria: RCA_RUBRIC.criteria.map((c) => ({
        id: c.id,
        met: fx.groundTruth[c.id] === true,
        reasoning: "oracle",
      })),
    });
}

interface Row {
  fixture: string;
  criterion: string;
  declared: boolean;
  judged: boolean;
  ok: boolean;
  reasoning: string;
}

async function main(): Promise<void> {
  if (/^claude/i.test(MODEL)) {
    throw new Error(`The rubric judge must run on OpenAI (gpt-5.1), never the Anthropic path; got ${MODEL}`);
  }
  if (!OFFLINE) ensureOpenAIKey();

  log("================ RUBRIC PROOF — output-quality judge on ground-truth artifacts ================");
  log(`judge model ......... ${OFFLINE ? "OFFLINE ORACLE (deterministic-logic check only, NOT proof)" : MODEL}`);
  log(`rubric .............. ${RCA_RUBRIC.id}  (${RCA_RUBRIC.criteria.length} criteria, pass >= ${RCA_RUBRIC.passThreshold})`);
  log(`fixtures ............ ${RUBRIC_FIXTURES.length}`);
  log("");

  const rows: Row[] = [];
  const results = new Map<string, RubricResult>();
  let labelsOk = true;

  for (const fx of RUBRIC_FIXTURES) {
    process.stdout.write(`  scoring ${fx.id} ... `);
    let res: RubricResult;
    try {
      res = await scoreRubric({
        artifact: fx.artifact,
        sourceMaterial: proveSourceMaterial(),
        rubric: RCA_RUBRIC,
        model: MODEL,
        llm: OFFLINE ? oracleFor(fx) : undefined,
        logger: (m) => process.stdout.write(`\n     ${m}\n`),
      });
    } catch (e) {
      log(`ERROR: ${(e as Error).message}`);
      throw e;
    }
    results.set(fx.id, res);
    const byId = new Map(res.perCriterion.map((c) => [c.id, c]));
    for (const c of RCA_RUBRIC.criteria) {
      const v = byId.get(c.id);
      const declared = fx.groundTruth[c.id] === true;
      const judged = v?.met === true;
      rows.push({ fixture: fx.id, criterion: c.id, declared, judged, ok: declared === judged, reasoning: v?.reasoning ?? "(none)" });
    }
    const labelOk = res.passed === fx.expectedPass;
    if (!labelOk) labelsOk = false;
    log(`score ${res.score}/${res.total} passed=${res.passed} (expected ${fx.expectedScore}/${res.total} pass=${fx.expectedPass})  ${labelOk ? "LABEL-OK" : "LABEL-XX"}`);
  }

  // Per-criterion table.
  log("");
  log("---- per-criterion: declared vs judged ----");
  log(["fixture".padEnd(18), "criterion".padEnd(24), "decl/judged".padEnd(14), "OK"].join(" "));
  for (const r of rows) {
    log([r.fixture.padEnd(18), r.criterion.padEnd(24), `${String(r.declared)}/${String(r.judged)}`.padEnd(14), r.ok ? "OK" : "XX"].join(" "));
  }
  const misses = rows.filter((r) => !r.ok);
  if (misses.length) {
    log("");
    log("---- per-criterion MISMATCHES (judge reasoning) ----");
    for (const r of misses) log(`  ${r.fixture} / ${r.criterion}: declared=${r.declared} judged=${r.judged}\n     ${r.reasoning}`);
  }

  // Empty-artifact short-circuit (no model call).
  log("");
  log("---- empty artifact must score 0 without a model call ----");
  let sentToModel = false;
  const emptyRes = await scoreRubric({
    artifact: "   ",
    sourceMaterial: proveSourceMaterial(),
    rubric: RCA_RUBRIC,
    model: MODEL,
    llm: async () => {
      sentToModel = true;
      return "{}";
    },
  });
  const emptyOk = emptyRes.emptyArtifact === true && emptyRes.score === 0 && emptyRes.passed === false && !sentToModel;
  log(`  emptyArtifact=${emptyRes.emptyArtifact} score=${emptyRes.score} passed=${emptyRes.passed} modelCalled=${sentToModel}  ${emptyOk ? "PASS" : "FAIL"}`);

  // Verdicts.
  const perCriterionMatches = rows.filter((r) => r.ok).length;
  const perCriterionAll = perCriterionMatches === rows.length;
  const strong = results.get("strong-rca");
  const partial = results.get("partial-rca");
  const vague = results.get("vague-rca");
  const confab = results.get("confabulated-rca");
  const strongHigh = !!strong && strong.score >= RCA_RUBRIC.passThreshold;
  const weakLow = !!vague && !!confab && vague.score < RCA_RUBRIC.passThreshold && confab.score < RCA_RUBRIC.passThreshold;
  const confidentWrongLow = !!confab && !!strong && confab.score < strong.score; // graded on substance, not fluency
  const boundaryOk = !!partial && partial.score === 3 && partial.passed === true;
  const separation = strongHigh && weakLow && confidentWrongLow;

  log("");
  log("================ RUBRIC PROOF verdict ================");
  log(`pass/fail labels match ......... ${labelsOk ? "PASS" : "FAIL"}  (4/4 fixtures)`);
  log(`per-criterion matches .......... ${perCriterionMatches}/${rows.length}  ${perCriterionAll ? "PASS" : "FAIL"}`);
  log(`strong high (>=${RCA_RUBRIC.passThreshold}) / weak low (<${RCA_RUBRIC.passThreshold}) . ${separation ? "PASS" : "FAIL"}  (strong=${strong?.score} partial=${partial?.score} vague=${vague?.score} confab=${confab?.score})`);
  log(`confident-wrong scores low ..... ${confidentWrongLow ? "PASS" : "FAIL"}  (confabulated < strong — substance not fluency)`);
  log(`boundary lands at threshold .... ${boundaryOk ? "PASS" : "FAIL"}  (partial=3/4, pass)`);
  log(`empty artifact short-circuits .. ${emptyOk ? "PASS" : "FAIL"}`);
  const pass = labelsOk && perCriterionAll && separation && boundaryOk && emptyOk;
  log("");
  log(`RUBRIC PROOF VERDICT: ${pass ? "PASS — the rubric judge reproduces ground truth (per-criterion + labels) and grades substance over fluency" : "FAIL — see mismatches above"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
