/**
 * scenarios/context-load — ONE context-load scenario (plan file #10, AC4).
 *
 * Load QUALITY, not turn-count (F7): the target moment is buried behind three
 * distractor turns that EACH plausibly match a DIFFERENT procedure family's
 * keywords, and the target moment is phrased so it does NOT token-overlap the
 * target procedure's frontmatter keywords — a >=2-token BM25 gate misses it, yet
 * body-level retrieval still keeps the target inside the top-K CANDIDATE set so
 * the H1 compile can disambiguate it (verified empirically; see `retrievalFacts`).
 *
 * The scenario DECLARES its authored applicable set (the judge denominator) and
 * an authored A->B chain. The `description` is PROCEDURE-AGNOSTIC — it is
 * interpolated verbatim into the user-simulator system prompt (a known #705 leak
 * class), so it is asserted clean of every procedure id at load time.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Chain } from "../types.ts";

/** A distractor turn and the DISTINCT procedure family its keywords evoke (AC4). */
export interface Distractor {
  text: string;
  /** The procedure family this distractor plausibly matches (BM25-verified). */
  matchesFamily: string;
  /** The top BM25 hits this distractor produces (evidence it maps elsewhere). */
  retrievesTop: string[];
}

export interface ContextLoadScenario {
  id: string;
  name: string;
  /** Procedure-agnostic (asserted clean of all procedure ids). */
  description: string;
  /** AUTHORED applicable procedure ids — the judge denominator, never judge-decided. */
  applicable: string[];
  /** Authored transitive chain(s) centered on the target. */
  chains: Chain[];
  /** The chain root / primary target procedure. */
  targetProcedure: string;
  /** The keyword-evasive target user turn. */
  targetMoment: string;
  /** Frontmatter keywords of the target procedure (for the overlap check). */
  targetFrontmatterKeywords: string[];
  /** Ordered distractor turns (each maps to a DIFFERENT family). */
  distractors: Distractor[];
  /** Empirical retrieval facts captured at authoring time (AC4 evidence). */
  retrievalFacts: {
    targetRankOutOf144: number;
    targetInTopK: number;
    targetFrontmatterOverlapCount: number;
    distractorFamilies: string[];
  };
}

/**
 * The ordered user turns for the session: three distractors then the buried,
 * keyword-evasive target. Each distractor evokes a distinct family; none evokes
 * the target set.
 */
const DISTRACTORS: Distractor[] = [
  {
    text: "Separately, the API gateway is throwing 500s for about 20% of requests right now — dig in and get it healthy again.",
    matchesFamily: "gateway (audit/restart/decommission/reconfigure-gateway)",
    retrievesTop: ["warm-cache", "audit-gateway", "decommission-gateway", "throttle-endpoint", "reconfigure-gateway"],
  },
  {
    text: "While you're at it, the TLS certificate on the edge proxy is close to expiry — replace it before it lapses.",
    matchesFamily: "certificate (rotate/revoke/validate-certificate)",
    retrievesTop: ["rotate-certificate", "archive-certificate", "validate-certificate", "audit-certificate", "rotate-credential"],
  },
  {
    text: "And last quarter's analytics dataset should be moved into cold archival storage to free space.",
    matchesFamily: "dataset (archive/purge-dataset)",
    retrievesTop: ["archive-dataset", "archive-invoice", "archive-record", "archive-ticket", "rollback-release"],
  },
];

const TARGET_MOMENT =
  "A customer returned an order and is owed money back against the original charge. Give it back to them, record the reason code, and confirm the amount is settled.";

export const contextLoadScenario: ContextLoadScenario = {
  id: "context-load-refund",
  name: "context-load: buried keyword-evasive target under distractor load",
  description:
    "The user is a back-office operations assistant working through a batch of unrelated requests in a single live session. For each request, identify whether one of the team's written operating procedures applies and, if so, carry out that procedure's steps as concrete actions using the available tools. Handle the requests as they come.",
  applicable: ["handle-refund", "reconcile-invoice"],
  chains: [
    {
      root: "handle-refund",
      steps: ["handle-refund", "reconcile-invoice"],
      description: "After handling the refund, reconcile the ledger so the books agree (transitive hand-off).",
    },
  ],
  targetProcedure: "handle-refund",
  targetMoment: TARGET_MOMENT,
  targetFrontmatterKeywords: ["handle", "refund", "runbook", "operation", "safety"],
  distractors: DISTRACTORS,
  retrievalFacts: {
    targetRankOutOf144: 4,
    targetInTopK: 8,
    targetFrontmatterOverlapCount: 0,
    distractorFamilies: ["gateway", "certificate", "dataset"],
  },
};

/** Ordered user turns: distractors first, target buried last. */
export function scenarioTurns(s: ContextLoadScenario = contextLoadScenario): string[] {
  return [...s.distractors.map((d) => d.text), s.targetMoment];
}

/**
 * Seed the CLEAN project cwd with minimal back-office state so BOTH target
 * procedures' steps are ENACTABLE as real tool actions:
 *   - `handle-refund`: read the charge (state/charge-8842.json), the returned
 *     order (state/orders/ord_8842.json), and the ledger (state/ledger.jsonl).
 *   - `reconcile-invoice` (the transitive hand-off): read the invoice
 *     (state/invoice-8842.json) and the reconciliation report
 *     (state/reconciliation-8842.json), resolve the seeded discrepancy (the
 *     invoice balance still shows the pre-refund 129.90 vs the report's
 *     source-of-truth 0.00), and confirm the settlement flag
 *     (state/settlement-8842.json, `settled:false` → `true`).
 *
 * The `reconcile-invoice` artifacts (invoice + reconciliation report +
 * settlement flag — the procedure's `## Inputs and outputs`) were ADDED for H3:
 * across baseline/H1/H2 `reconcile-invoice` was `followed=false` every time and
 * its artifacts were NOT seeded, so the dropped hand-off was ALSO under-enactable
 * (a confound). Without this seed, H3's per-procedure block fires correctly on
 * `reconcile-invoice` but the subject cannot satisfy it → cap-hit, not a flip.
 * All three are tied to the SAME order/charge (ord_8842 / ch_8842) so the refund
 * → reconcile chain is concrete.
 *
 * Neutral filenames — none is a procedure id (`reconcile-invoice`/`handle-refund`
 * never appear), so the cwd still cannot leak the corpus (L2); they parallel the
 * pre-existing `charge-8842.json` object-noun style. Distractor requests need no
 * seeded state (they are load; the subject investigates and finds nothing).
 */
export function seedProject(projectDir: string): string[] {
  const stateDir = join(projectDir, "state");
  mkdirSync(stateDir, { recursive: true });
  const written: string[] = [];
  const put = (rel: string, body: string) => {
    const p = join(projectDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, "utf8");
    written.push(rel);
  };
  put(
    "state/charge-8842.json",
    JSON.stringify(
      { charge_id: "ch_8842", order_id: "ord_8842", customer_id: "c_5521", amount: 129.9, currency: "USD", status: "captured", captured_at: "2026-06-30T14:02:11Z" },
      null,
      2,
    ) + "\n",
  );
  put(
    "state/orders/ord_8842.json",
    JSON.stringify(
      { order_id: "ord_8842", customer_id: "c_5521", status: "returned", returned_at: "2026-07-09T09:11:00Z", items: [{ sku: "SKU-114", qty: 1, price: 129.9 }] },
      null,
      2,
    ) + "\n",
  );
  put(
    "state/ledger.jsonl",
    [
      JSON.stringify({ entry: "e_2001", ref: "ch_8842", type: "charge", amount: 129.9, balance: 129.9 }),
      JSON.stringify({ entry: "e_2002", ref: "misc", type: "charge", amount: 42.0, balance: 171.9 }),
    ].join("\n") + "\n",
  );

  // --- reconcile-invoice artifacts (the transitive hand-off; ADDED for H3) ---
  // The invoice: its `## Inputs and outputs` (line items, tax summary, payment
  // reference, balance). balance still shows the PRE-refund 129.90 — the seeded
  // discrepancy the subject must resolve (procedure step 3).
  put(
    "state/invoice-8842.json",
    JSON.stringify(
      {
        invoice_id: "inv_8842",
        order_id: "ord_8842",
        payment_reference: "ch_8842",
        line_items: [{ sku: "SKU-114", qty: 1, amount: 129.9 }],
        tax_summary: { rate: 0.0, tax: 0.0, total_tax: 0.0 },
        balance: 129.9,
      },
      null,
      2,
    ) + "\n",
  );
  // The reconciliation report = the source of truth to gather the invoice from
  // and compare the balance against (steps 1-2). After the full refund of
  // ch_8842, the source-of-truth balance is 0.00 — hence the discrepancy above.
  put(
    "state/reconciliation-8842.json",
    JSON.stringify(
      {
        report_id: "rec_8842",
        order_id: "ord_8842",
        payment_reference: "ch_8842",
        source_of_truth_balance: 0.0,
        expected_line_items: [{ sku: "SKU-114", qty: 1, amount: 129.9, returned: true }],
        note: "Order ord_8842 was returned and charge ch_8842 refunded in full; the invoice balance must be brought into agreement at 0.00 and the settlement confirmed.",
      },
      null,
      2,
    ) + "\n",
  );
  // The settlement flag the subject confirms (step 4): flip settled false → true.
  put(
    "state/settlement-8842.json",
    JSON.stringify(
      { order_id: "ord_8842", payment_reference: "ch_8842", settled: false, settled_at: null },
      null,
      2,
    ) + "\n",
  );
  return written;
}

// ===========================================================================
// DISCRIMINATING scenario (context-load-vendor) — a DEEP 3-hop transitive chain
// with the two validity controls from FINDINGS §j:
//   (a) AVAILABLE — chain-expansion retrieval injects the whole chain
//       (onboard-vendor -> provision-account -> grant-access), so a dropped hop
//       is an adherence choice, not a retrieval-miss (the deep hops are NOT
//       co-retrieved: provision-account rank 47, grant-access rank 11 of 168).
//   (b) NECESSARY — the seed is deliberately NON-TELEGRAPHING: it makes each hop
//       ENACTABLE (source + target files present) but does NOT imply the
//       procedure-mandated steps. The correct actions (create a REVIEW-BOARD
//       record, apply the BASELINE CONFIG, attach ENTITLEMENTS, set an EXPIRY on
//       the role binding, and the three "confirm <state>" steps) come ONLY from
//       the injected procedure bodies — the task states an outcome, not the how.
// The bet: under 3 distractor turns of load, a subject drops a non-obvious step
// or the deepest hop -> baseline < 1.0 (calibrated before any head-to-head).
// ===========================================================================

const VENDOR_TARGET_MOMENT =
  "We just signed a new supplier and they need to be set up completely, end to end, so their team can start working in our systems today. Collect and file their intake paperwork and contract terms, record them and confirm approval, then make sure they can actually sign in and operate.";

export const contextLoadVendorScenario: ContextLoadScenario = {
  id: "context-load-vendor",
  name: "context-load: buried keyword-evasive 3-hop chain (vendor onboarding) under distractor load",
  // Procedure-agnostic (identical to the refund scenario's — asserted clean).
  description:
    "The user is a back-office operations assistant working through a batch of unrelated requests in a single live session. For each request, identify whether one of the team's written operating procedures applies and, if so, carry out that procedure's steps as concrete actions using the available tools. Handle the requests as they come.",
  applicable: ["onboard-vendor", "provision-account", "grant-access"],
  chains: [
    {
      root: "onboard-vendor",
      steps: ["onboard-vendor", "provision-account", "grant-access"],
      description:
        "Onboarding a supplier transitively requires provisioning its account and then granting access (3-hop). Following onboard-vendor but stopping before provision-account or grant-access is a transitive-adherence failure.",
    },
  ],
  targetProcedure: "onboard-vendor",
  targetMoment: VENDOR_TARGET_MOMENT,
  targetFrontmatterKeywords: ["onboard", "vendor", "controlled", "procedure", "runbook"],
  distractors: DISTRACTORS,
  retrievalFacts: {
    // Verified 0-bucket (scratchpad/retrieval-check.mjs): onboard-vendor rank 1/168,
    // 0 frontmatter-keyword overlap with the target moment; provision-account and
    // grant-access are surfaced via CHAIN-EXPANSION (ranks 47 / 11 on raw BM25).
    targetRankOutOf144: 1,
    targetInTopK: 8,
    targetFrontmatterOverlapCount: 0,
    distractorFamilies: ["gateway", "certificate", "dataset"],
  },
};

/**
 * Seed the vendor 3-hop chain (entity: supplier s_3307). ENACTABLE per hop
 * (source to read + target to write), but NON-TELEGRAPHING: the procedure-mandated
 * steps are NOT implied by the seed. In particular `role-request-3307.json`
 * carries NO `expiry` field and the existing `audit-ledger.jsonl` bindings have
 * NO expiry — so "set an expiry on the role binding" (grant-access step 3) comes
 * ONLY from the procedure text; a loaded subject that skips it misses grant-access.
 * Neutral object-noun filenames (none is a procedure id) — cwd cannot leak (L2).
 */
export function seedVendorProject(projectDir: string): string[] {
  const written: string[] = [];
  const put = (rel: string, body: string) => {
    const p = join(projectDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, "utf8");
    written.push(rel);
  };
  // onboard-vendor: the intake to collect (step 1) — profile, contract, attestation, contacts.
  put(
    "state/intake-3307.json",
    JSON.stringify(
      {
        supplier_id: "s_3307",
        legal_name: "Northwind Components LLC",
        contract: { term_months: 24, value_usd: 180000, signed_at: "2026-07-10" },
        compliance: { attestation: "received", doc_id: "att_3307" },
        contacts: [
          { name: "R. Alvarez", email: "alvarez@northwind.example", role: "primary" },
          { name: "T. Osei", email: "osei@northwind.example", role: "billing" },
        ],
      },
      null,
      2,
    ) + "\n",
  );
  // onboard-vendor step 2/4: the review board (append a record; confirm approval). Existing pattern.
  put(
    "state/review-board.jsonl",
    [
      JSON.stringify({ supplier_id: "s_3301", legal_name: "Acme Parts", approval: "approved" }),
      JSON.stringify({ supplier_id: "s_3305", legal_name: "Beacon Freight", approval: "approved" }),
    ].join("\n") + "\n",
  );
  // provision-account step 1: existing billing accounts (allocate the new one here).
  put(
    "state/billing-accounts.jsonl",
    [
      JSON.stringify({ account_id: "acct_5501", supplier_id: "s_3301", tier: "standard", active: true }),
      JSON.stringify({ account_id: "acct_5505", supplier_id: "s_3305", tier: "standard", active: true }),
    ].join("\n") + "\n",
  );
  // provision-account step 2: the baseline configuration to APPLY (not implied by the task).
  put(
    "state/baseline-config.json",
    JSON.stringify(
      { region: "eu-central", quota: { requests_per_min: 600 }, features: ["reporting", "webhooks"], notes: "apply verbatim to every newly provisioned account" },
      null,
      2,
    ) + "\n",
  );
  // provision-account step 3: existing entitlement sets (attach the new one).
  put(
    "state/entitlements.jsonl",
    [
      JSON.stringify({ account_id: "acct_5501", entitlements: ["catalog:read", "orders:write"] }),
      JSON.stringify({ account_id: "acct_5505", entitlements: ["catalog:read", "orders:write"] }),
    ].join("\n") + "\n",
  );
  // grant-access step 1: the request scope to confirm + the approval ref. NO expiry
  // field here — "set an expiry" must come from the procedure, not the seed.
  put(
    "state/role-request-3307.json",
    JSON.stringify(
      { supplier_id: "s_3307", requested_scope: ["portal:login", "orders:write", "invoices:read"], approval_ref: "att_3307" },
      null,
      2,
    ) + "\n",
  );
  // grant-access step 2/3/4: the audit ledger to bind into. Existing entries carry
  // NO expiry (non-telegraphing) — the procedure is the only source of the expiry step.
  put(
    "state/audit-ledger.jsonl",
    [
      JSON.stringify({ entry: "ab_9001", subject: "acct_5501", role_binding: "vendor-standard", status: "active" }),
      JSON.stringify({ entry: "ab_9005", subject: "acct_5505", role_binding: "vendor-standard", status: "active" }),
    ].join("\n") + "\n",
  );
  return written;
}

// --- Scenario registry: runners select via ADHERENCE_SCENARIO (default refund). ---
export interface ScenarioBundle {
  scenario: ContextLoadScenario;
  /** The scenario-specific project seeder (enactability is scenario-coupled). */
  seed: (projectDir: string) => string[];
}

export const SCENARIOS: Record<string, ScenarioBundle> = {
  "context-load-refund": { scenario: contextLoadScenario, seed: seedProject },
  "context-load-vendor": { scenario: contextLoadVendorScenario, seed: seedVendorProject },
};

/** Resolve the scenario bundle by id (env ADHERENCE_SCENARIO); defaults to the refund scenario. */
export function getScenarioBundle(id?: string): ScenarioBundle {
  const key = id && SCENARIOS[id] ? id : "context-load-refund";
  return SCENARIOS[key];
}

/**
 * Assert the description (interpolated into the user-sim system prompt) names no
 * procedure id — the #705 leak guard (AC9). Throws naming the offender.
 */
export function assertDescriptionClean(description: string, procedureIds: string[]): void {
  const lower = description.toLowerCase();
  const leaked = procedureIds.filter((id) => lower.includes(id.toLowerCase()));
  if (leaked.length) {
    throw new Error(`scenario description leaks procedure ids: ${leaked.join(", ")}`);
  }
  // Also guard the bare object nouns that would trivially reveal the target.
  for (const banned of ["refund", "invoice", "reconcile"]) {
    if (lower.includes(banned)) {
      throw new Error(`scenario description leaks target vocabulary: "${banned}"`);
    }
  }
}
