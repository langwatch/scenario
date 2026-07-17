/**
 * generate-corpus — deterministically synthesize a neutral-vocabulary procedure
 * corpus large enough to stuff an agent's context (> 200,000 REAL tokens,
 * measured with gpt-tokenizer), with authored A->B transitive chains and a
 * machine-readable manifest.
 *
 * NEUTRAL vocabulary only (public repo): domain-generic operations like
 * deploy-service / rotate-credential / handle-refund / escalate-ticket. No
 * internal/proprietary vocabulary — the generator self-checks its own output
 * against that blocklist (configurable via ADHERENCE_BANNED_TERMS) and throws.
 *
 * Determinism: a fixed-seed PRNG, so `pnpm tsx generate-corpus.ts` reproduces the
 * committed corpus byte-for-byte.
 *
 * Run:  tsx generate-corpus.ts        (writes ./corpus + ./corpus/manifest.json)
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { encode } from "gpt-tokenizer";

import type { Chain, CorpusManifest, ScenarioSet } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(HERE, "corpus");
const SEED = 78_420_711;
const TOKENIZER = "gpt-tokenizer/o200k_base";
const TOKEN_TARGET = 240_000; // margin above the 200k gate

const BANNED = new RegExp(process.env.ADHERENCE_BANNED_TERMS ?? "langwatch|acme-internal", "i");

// --- deterministic PRNG (mulberry32) ---------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rng = mulberry32(SEED);
const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];
const pickN = <T>(arr: T[], n: number): T[] => {
  const copy = [...arr];
  const out: T[] = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
  return out;
};
/** Sample n items WITH replacement (so n may exceed the pool size). */
const sampleN = <T>(arr: T[], n: number): T[] => Array.from({ length: n }, () => pick(arr));

// --- neutral vocabulary -----------------------------------------------------
const OBJECTS: Record<string, { noun: string; artifacts: string[]; systems: string[]; signal: string }> = {
  service: { noun: "service", artifacts: ["the deployment manifest", "the health endpoint", "the version tag", "the rollout config"], systems: ["the orchestration layer", "the load balancer", "the release registry"], signal: "the readiness probe" },
  credential: { noun: "credential", artifacts: ["the secret material", "the rotation record", "the access scope", "the expiry timestamp"], systems: ["the secret store", "the identity provider", "the audit ledger"], signal: "the validation check" },
  account: { noun: "account", artifacts: ["the account record", "the entitlement set", "the contact profile", "the tier assignment"], systems: ["the directory", "the billing system", "the provisioning queue"], signal: "the activation status" },
  invoice: { noun: "invoice", artifacts: ["the line items", "the tax summary", "the payment reference", "the balance"], systems: ["the ledger", "the reconciliation report", "the billing system"], signal: "the settlement flag" },
  ticket: { noun: "ticket", artifacts: ["the ticket summary", "the severity label", "the owner assignment", "the resolution notes"], systems: ["the queue", "the notification channel", "the on-call rota"], signal: "the acknowledgement" },
  record: { noun: "record", artifacts: ["the record body", "the retention label", "the checksum", "the index entry"], systems: ["the datastore", "the archive tier", "the search index"], signal: "the integrity check" },
  endpoint: { noun: "endpoint", artifacts: ["the route table", "the rate limit", "the timeout budget", "the schema version"], systems: ["the gateway", "the traffic mesh", "the metrics pipeline"], signal: "the latency SLO" },
  cache: { noun: "cache", artifacts: ["the cache keys", "the eviction policy", "the warm set", "the hit ratio"], systems: ["the cache tier", "the origin store", "the invalidation channel"], signal: "the staleness bound" },
  datastore: { noun: "datastore", artifacts: ["the snapshot", "the replication lag", "the schema", "the backup catalog"], systems: ["the primary", "the replica set", "the backup vault"], signal: "the consistency check" },
  schema: { noun: "schema", artifacts: ["the migration script", "the column set", "the constraint list", "the version marker"], systems: ["the migration runner", "the datastore", "the compatibility gate"], signal: "the migration status" },
  payment: { noun: "payment", artifacts: ["the payment intent", "the authorization code", "the amount", "the settlement record"], systems: ["the payment processor", "the ledger", "the fraud check"], signal: "the capture status" },
  notification: { noun: "notification", artifacts: ["the message template", "the recipient list", "the delivery window", "the throttle budget"], systems: ["the delivery gateway", "the subscription list", "the bounce log"], signal: "the delivery receipt" },
  vendor: { noun: "vendor", artifacts: ["the vendor profile", "the contract terms", "the compliance attestation", "the contact set"], systems: ["the vendor directory", "the procurement system", "the review board"], signal: "the approval state" },
  release: { noun: "release", artifacts: ["the changelog", "the artifact bundle", "the version number", "the sign-off record"], systems: ["the release registry", "the artifact store", "the distribution channel"], signal: "the promotion gate" },
  gateway: { noun: "gateway", artifacts: ["the routing rules", "the upstream pool", "the header policy", "the connection limits"], systems: ["the edge tier", "the upstream services", "the config store"], signal: "the health signal" },
  queue: { noun: "queue", artifacts: ["the message backlog", "the visibility timeout", "the dead-letter target", "the consumer group"], systems: ["the broker", "the consumers", "the metrics pipeline"], signal: "the backlog depth" },
  cluster: { noun: "cluster", artifacts: ["the node pool", "the capacity plan", "the placement rules", "the drain policy"], systems: ["the scheduler", "the node pool", "the metrics pipeline"], signal: "the saturation level" },
  certificate: { noun: "certificate", artifacts: ["the certificate chain", "the private key", "the expiry date", "the subject list"], systems: ["the certificate authority", "the secret store", "the edge tier"], signal: "the validity window" },
  policy: { noun: "policy", artifacts: ["the policy document", "the effective date", "the scope list", "the exception log"], systems: ["the policy store", "the review board", "the enforcement layer"], signal: "the compliance state" },
  dataset: { noun: "dataset", artifacts: ["the dataset snapshot", "the schema descriptor", "the row count", "the lineage record"], systems: ["the datastore", "the pipeline", "the catalog"], signal: "the freshness marker" },
  report: { noun: "report", artifacts: ["the report body", "the metric summary", "the distribution list", "the reporting window"], systems: ["the reporting pipeline", "the datastore", "the distribution channel"], signal: "the sign-off" },
  file: { noun: "file", artifacts: ["the file contents", "the checksum", "the quarantine label", "the retention flag"], systems: ["the object store", "the scanning service", "the archive tier"], signal: "the scan verdict" },
  refund: { noun: "refund", artifacts: ["the refund request", "the original charge", "the refund amount", "the reason code"], systems: ["the payment processor", "the ledger", "the case queue"], signal: "the refund state" },
  access: { noun: "access grant", artifacts: ["the role binding", "the scope set", "the expiry", "the approval record"], systems: ["the identity provider", "the directory", "the audit ledger"], signal: "the grant status" },
};

const VERBS: Record<string, { title: string; purpose: string; stepStems: string[] }> = {
  deploy: { title: "Deploy", purpose: "roll a new version of {noun} into production safely and reversibly", stepStems: ["stage the change behind a guard", "promote {noun} incrementally", "watch {signal} during rollout", "confirm {artifact} matches the intended version"] },
  rollback: { title: "Roll Back", purpose: "revert {noun} to the last known-good state after a failed change", stepStems: ["identify the last known-good version of {noun}", "halt further promotion", "restore {artifact}", "confirm {signal} returns to baseline"] },
  restart: { title: "Restart", purpose: "cycle {noun} to clear transient faults without data loss", stepStems: ["drain in-flight work from {noun}", "cycle {system}", "wait for {signal}", "verify {artifact} is intact"] },
  scale: { title: "Scale", purpose: "adjust the capacity of {noun} to meet demand", stepStems: ["measure current load on {noun}", "compute the target capacity", "apply the change to {system}", "watch {signal} stabilize"] },
  decommission: { title: "Decommission", purpose: "retire {noun} and reclaim its resources cleanly", stepStems: ["confirm {noun} carries no live traffic", "detach {noun} from {system}", "archive {artifact}", "record the retirement"] },
  patch: { title: "Patch", purpose: "apply a corrective change to {noun} with minimal disruption", stepStems: ["obtain the approved patch for {noun}", "apply it to {system}", "re-run {signal}", "record the patch level in {artifact}"] },
  reconfigure: { title: "Reconfigure", purpose: "change the configuration of {noun} in a controlled way", stepStems: ["capture the current configuration of {noun}", "apply the new settings to {system}", "validate against {signal}", "persist {artifact}"] },
  snapshot: { title: "Snapshot", purpose: "capture a consistent point-in-time copy of {noun}", stepStems: ["quiesce writes to {noun}", "capture {artifact}", "verify the snapshot against {signal}", "register it in {system}"] },
  drain: { title: "Drain", purpose: "gracefully remove work from {noun} before maintenance", stepStems: ["stop new work reaching {noun}", "let in-flight work on {system} complete", "watch {signal} reach zero", "confirm {artifact}"] },
  replicate: { title: "Replicate", purpose: "create and verify a redundant copy of {noun}", stepStems: ["select the replication target for {noun}", "copy {artifact} to {system}", "verify {signal}", "record the replica"] },
  rotate: { title: "Rotate", purpose: "replace {noun} with a fresh instance and retire the old one", stepStems: ["generate a replacement for {noun}", "publish the new {artifact} to {system}", "confirm {signal}", "schedule retirement of the old value"] },
  revoke: { title: "Revoke", purpose: "invalidate {noun} so it can no longer be used", stepStems: ["locate every place {noun} is honored", "invalidate it in {system}", "confirm {signal} shows it inactive", "log the revocation in {artifact}"] },
  provision: { title: "Provision", purpose: "create and prepare {noun} for first use", stepStems: ["allocate {noun} in {system}", "apply the baseline configuration", "attach {artifact}", "confirm {signal}"] },
  audit: { title: "Audit", purpose: "review {noun} against policy and record findings", stepStems: ["enumerate {noun} in {system}", "compare each against policy", "record deviations in {artifact}", "confirm {signal}"] },
  backup: { title: "Back Up", purpose: "produce a recoverable copy of {noun}", stepStems: ["freeze {noun} to a consistent state", "write {artifact} to {system}", "verify the backup against {signal}", "record the catalog entry"] },
  restore: { title: "Restore", purpose: "recover {noun} from a known-good copy", stepStems: ["select the recovery point for {noun}", "restore {artifact} into {system}", "verify {signal}", "reconcile any gap"] },
  validate: { title: "Validate", purpose: "check that {noun} meets its correctness criteria", stepStems: ["load {noun} from {system}", "run the checks against {artifact}", "confirm {signal}", "record the outcome"] },
  grant: { title: "Grant", purpose: "give a principal the {noun} it requires, no more", stepStems: ["confirm the request scope for {noun}", "apply the binding in {system}", "set an expiry on {artifact}", "confirm {signal}"] },
  escalate: { title: "Escalate", purpose: "route {noun} to the right responder without delay", stepStems: ["classify the severity of {noun}", "assign an owner in {system}", "notify via {artifact}", "confirm {signal}"] },
  archive: { title: "Archive", purpose: "move {noun} to long-term storage under its retention rules", stepStems: ["confirm {noun} is eligible for archival", "move {artifact} to {system}", "verify {signal}", "update the index"] },
  purge: { title: "Purge", purpose: "permanently remove {noun} once it is no longer needed", stepStems: ["confirm {noun} is past its retention", "remove it from {system}", "confirm {signal}", "record the deletion in {artifact}"] },
  migrate: { title: "Migrate", purpose: "move {noun} to a new format or location without loss", stepStems: ["prepare the migration for {noun}", "apply it to {system}", "verify {signal}", "reconcile {artifact}"] },
  throttle: { title: "Throttle", purpose: "limit the rate at which {noun} is served to protect the system", stepStems: ["measure current pressure on {noun}", "set the limit in {system}", "watch {signal}", "record the applied limit in {artifact}"] },
  dispatch: { title: "Dispatch", purpose: "send {noun} to its recipients reliably", stepStems: ["assemble {noun} from {artifact}", "hand it to {system}", "confirm {signal}", "record delivery"] },
  reconcile: { title: "Reconcile", purpose: "bring {noun} into agreement with the source of truth", stepStems: ["gather {noun} from {system}", "compare against {artifact}", "resolve each discrepancy", "confirm {signal}"] },
  publish: { title: "Publish", purpose: "make {noun} available to its consumers under change control", stepStems: ["finalize {noun}", "promote {artifact} through {system}", "confirm {signal}", "announce availability"] },
  review: { title: "Review", purpose: "evaluate {noun} and record an explicit decision", stepStems: ["collect {noun} and its context from {system}", "assess it against {artifact}", "record the decision", "confirm {signal}"] },
  onboard: { title: "Onboard", purpose: "bring {noun} into the system with all prerequisites met", stepStems: ["collect the intake details for {noun}", "create the records in {system}", "attach {artifact}", "confirm {signal}"] },
  offboard: { title: "Offboard", purpose: "remove {noun} from the system and revoke its access", stepStems: ["confirm {noun} is departing", "revoke access in {system}", "archive {artifact}", "confirm {signal}"] },
  quarantine: { title: "Quarantine", purpose: "isolate {noun} suspected of being unsafe", stepStems: ["move {noun} out of the active path", "isolate it in {system}", "flag {artifact}", "confirm {signal}"] },
  warm: { title: "Warm", purpose: "prime {noun} so first requests are fast", stepStems: ["identify the hot set for {noun}", "prime {system}", "confirm {signal}", "record {artifact}"] },
  handle: { title: "Handle", purpose: "process {noun} end-to-end within policy", stepStems: ["intake {noun} and confirm eligibility", "process it through {system}", "record {artifact}", "confirm {signal}"] },
};

// Generic reusable operational sentences for depth (neutral).
const NOTES = [
  "Keep the change small and reversible; a smaller blast radius is always preferable to a clever one-shot change.",
  "Record who performed the operation and when, so the audit ledger stays trustworthy.",
  "If any precondition is not met, stop and resolve it before proceeding — do not work around a failed gate.",
  "Prefer an idempotent operation: running the procedure twice should not corrupt state.",
  "Never disable a safety check to make a step pass; a red check is information, not an obstacle.",
  "Communicate the start and end of the operation on the appropriate channel so others are not surprised.",
  "Capture enough evidence during the run that a reviewer could reconstruct what happened without asking you.",
  "When in doubt about scope, choose the narrower interpretation and confirm before widening it.",
  "Treat timeouts and partial failures as first-class outcomes with their own handling, not as edge cases.",
  "Leave the system in a strictly better-understood state than you found it, even if you did not finish.",
  "A dry run against a non-production copy is cheap insurance for any irreversible step.",
  "Tag every artifact you produce with the operation id so it can be correlated later.",
];

const PRECONDS = [
  "You have the authorization required for this operation.",
  "A recent backup or recovery point exists and has been verified as restorable.",
  "The change window is open and stakeholders have been informed.",
  "No conflicting operation is in progress against the same target.",
  "The relevant dashboards and alerts are visible to you for the duration.",
  "The rollback path has been identified and is known to work.",
];

const WHENS = [
  "a scheduled maintenance window requires it",
  "an alert indicates the target has degraded",
  "a dependency change forces a corresponding update here",
  "a periodic policy requires the operation on a cadence",
  "a request from an owner has been approved",
  "a preceding procedure explicitly hands off to this one",
];

const FAILURES = [
  "the change is accepted by one system but silently rejected by another, leaving state divergent",
  "a partial write completes and then the connection drops before acknowledgement",
  "a stale cache continues to serve the previous value after the change is applied",
  "the operation is retried and the second attempt collides with the first",
  "a downstream consumer is not ready and rejects the propagated change",
  "a timeout fires while the operation is still in flight, so its true status is unknown",
  "an unrelated concurrent change touches the same target and the two interleave",
  "the verification step passes against a cached reading rather than the live state",
  "a permission was sufficient to begin but not to complete, stranding the operation midway",
  "the rollback path itself depends on the thing being changed and is unavailable when needed",
];

const FILLER_SUBJECTS = [
  "The operator running this procedure",
  "A reviewer checking the result afterwards",
  "The change owner",
  "The on-call responder",
  "An auditor reconstructing the timeline later",
  "Anyone continuing this work in a follow-up session",
  "The person who signs off the operation",
];
const FILLER_PREDICATES = [
  "should confirm {artifact} reflects the intended state before treating the step as complete",
  "must record what was observed against the operation id so the history stays reconstructable",
  "is expected to verify {signal} independently rather than trusting a single reading",
  "should prefer stopping over guessing whenever {system} returns an ambiguous response",
  "must not disable a check to make progress, because a failing check is information",
  "should keep the blast radius small and the operation reversible at every point",
  "needs to confirm that {system} actually accepted the change and now reflects it",
  "should leave a clear note for the next person about what remains and why",
];

// --- id set + authored chains ----------------------------------------------
function id(v: string, o: string): string {
  return `${v}-${o}`;
}

// Curated (verb, object) pairs — all sensible + neutral. > 130 unique.
const PAIRS: Array<[string, string]> = [
  ["deploy", "service"], ["rollback", "service"], ["restart", "service"], ["scale", "service"], ["decommission", "service"], ["patch", "service"], ["reconfigure", "service"], ["snapshot", "service"], ["drain", "service"], ["replicate", "service"],
  ["rotate", "credential"], ["revoke", "credential"], ["provision", "credential"], ["audit", "credential"], ["backup", "credential"], ["restore", "credential"], ["validate", "credential"],
  ["grant", "access"], ["revoke", "access"], ["audit", "access"], ["review", "access"], ["reconcile", "access"],
  ["provision", "account"], ["decommission", "account"], ["audit", "account"], ["restore", "account"], ["reconfigure", "account"], ["onboard", "account"], ["offboard", "account"],
  ["reconcile", "invoice"], ["validate", "invoice"], ["archive", "invoice"], ["dispatch", "invoice"], ["audit", "invoice"],
  ["escalate", "ticket"], ["dispatch", "ticket"], ["archive", "ticket"], ["review", "ticket"], ["reconcile", "ticket"],
  ["archive", "record"], ["restore", "record"], ["purge", "record"], ["validate", "record"], ["replicate", "record"], ["audit", "record"],
  ["throttle", "endpoint"], ["validate", "endpoint"], ["reconfigure", "endpoint"], ["decommission", "endpoint"], ["patch", "endpoint"], ["snapshot", "endpoint"],
  ["purge", "cache"], ["warm", "cache"], ["validate", "cache"], ["reconfigure", "cache"], ["snapshot", "cache"],
  ["backup", "datastore"], ["restore", "datastore"], ["migrate", "datastore"], ["replicate", "datastore"], ["drain", "datastore"], ["snapshot", "datastore"], ["decommission", "datastore"],
  ["migrate", "schema"], ["validate", "schema"], ["rollback", "schema"], ["snapshot", "schema"], ["patch", "schema"],
  ["validate", "payment"], ["reconcile", "payment"], ["dispatch", "payment"], ["audit", "payment"], ["archive", "payment"],
  ["dispatch", "notification"], ["validate", "notification"], ["throttle", "notification"], ["archive", "notification"],
  ["onboard", "vendor"], ["offboard", "vendor"], ["audit", "vendor"], ["reconcile", "vendor"], ["review", "vendor"],
  ["publish", "release"], ["rollback", "release"], ["validate", "release"], ["archive", "release"], ["snapshot", "release"],
  ["reconfigure", "gateway"], ["restart", "gateway"], ["patch", "gateway"], ["audit", "gateway"], ["throttle", "gateway"], ["decommission", "gateway"],
  ["drain", "queue"], ["purge", "queue"], ["replicate", "queue"], ["validate", "queue"], ["snapshot", "queue"], ["reconfigure", "queue"],
  ["scale", "cluster"], ["drain", "cluster"], ["patch", "cluster"], ["snapshot", "cluster"], ["decommission", "cluster"], ["reconfigure", "cluster"], ["replicate", "cluster"],
  ["rotate", "certificate"], ["revoke", "certificate"], ["validate", "certificate"], ["provision", "certificate"], ["audit", "certificate"], ["archive", "certificate"],
  ["review", "policy"], ["publish", "policy"], ["archive", "policy"], ["validate", "policy"], ["audit", "policy"], ["reconcile", "policy"],
  ["validate", "dataset"], ["archive", "dataset"], ["replicate", "dataset"], ["purge", "dataset"], ["snapshot", "dataset"], ["restore", "dataset"], ["migrate", "dataset"], ["audit", "dataset"],
  ["quarantine", "file"], ["restore", "file"], ["validate", "file"], ["archive", "file"], ["purge", "file"],
  ["reconcile", "report"], ["publish", "report"], ["archive", "report"], ["validate", "report"], ["review", "report"],
  ["handle", "refund"], ["validate", "refund"], ["audit", "refund"], ["escalate", "refund"],
  ["deploy", "release"], ["provision", "gateway"], ["reconcile", "datastore"],
  // Added when procedure steps were shortened to 3-6 (from 16-21 near-duplicate
  // steps) so the corpus stays > 200k real tokens from more DISTINCT procedures
  // rather than leaning almost entirely on filler padding (see the "3-6 steps"
  // comment in buildBody). Same curation bar: sensible + neutral.
  ["restart", "cluster"], ["scale", "gateway"], ["scale", "datastore"], ["decommission", "queue"],
  ["patch", "datastore"], ["reconfigure", "datastore"], ["drain", "gateway"], ["provision", "queue"],
  ["provision", "cluster"], ["audit", "service"], ["audit", "cluster"], ["backup", "service"],
  ["restore", "service"], ["validate", "gateway"], ["validate", "cluster"], ["archive", "vendor"],
  ["purge", "report"], ["migrate", "service"], ["throttle", "service"], ["dispatch", "report"],
  ["reconcile", "dataset"], ["publish", "dataset"], ["review", "release"], ["snapshot", "gateway"],
];

const ALL_IDS = Array.from(new Set(PAIRS.map(([v, o]) => id(v, o))));
const ID_SET = new Set(ALL_IDS);
const META_ID = "author-procedure";

// Authored ground-truth transitive chains (A -> B [-> C]). Every step exists.
const CHAINS: Chain[] = [
  { root: "rotate-credential", steps: ["rotate-credential", "revoke-access"], description: "After rotating a credential, follow revoke-access to invalidate the superseded grant." },
  { root: "deploy-service", steps: ["deploy-service", "purge-cache"], description: "After deploying a service, follow purge-cache so stale entries are not served." },
  { root: "handle-refund", steps: ["handle-refund", "reconcile-invoice"], description: "After handling a refund, follow reconcile-invoice so the ledger agrees." },
  { root: "onboard-vendor", steps: ["onboard-vendor", "provision-account", "grant-access"], description: "Onboarding a vendor transitively requires provisioning its account and then granting access (3-hop)." },
];
const chainLinkFor = (procId: string): string | undefined => {
  const c = CHAINS.find((c) => c.root === procId);
  return c ? c.steps[1] : undefined;
};

const SCENARIOS: ScenarioSet[] = [
  { id: "scenario-credential-rotation", description: "A credential must be rotated during a maintenance window.", applicable: ["rotate-credential", "revoke-access", "audit-credential"], targetChainRoot: "rotate-credential" },
  { id: "scenario-service-deploy", description: "A new service version is promoted to production.", applicable: ["deploy-service", "purge-cache", "escalate-ticket"], targetChainRoot: "deploy-service" },
  { id: "scenario-refund", description: "A customer refund is processed end to end.", applicable: ["handle-refund", "reconcile-invoice", "validate-payment"], targetChainRoot: "handle-refund" },
  { id: "scenario-vendor-onboarding", description: "A new vendor is onboarded with account and access.", applicable: ["onboard-vendor", "provision-account", "grant-access"], targetChainRoot: "onboard-vendor" },
];

// --- body construction ------------------------------------------------------
function titleFor(v: string, o: string): string {
  const objNoun = OBJECTS[o]?.noun ?? o;
  return `${VERBS[v].title} ${objNoun.replace(/\b\w/g, (c) => c.toUpperCase())}`;
}

function fill(template: string, o: string): string {
  const od = OBJECTS[o];
  return template
    .replace(/\{noun\}/g, od.noun)
    .replace(/\{artifact\}/g, pick(od.artifacts))
    .replace(/\{system\}/g, pick(od.systems))
    .replace(/\{signal\}/g, od.signal);
}

function fillerParagraph(o: string, sentences: number): string {
  const out: string[] = [];
  for (let i = 0; i < sentences; i++) {
    const s = `${pick(FILLER_SUBJECTS)} ${fill(pick(FILLER_PREDICATES), o)}`;
    out.push(`${s}.`);
  }
  return out.join(" ");
}

function buildBody(v: string, o: string, links: string[], padRounds: number): string {
  const vd = VERBS[v];
  const od = OBJECTS[o];
  const title = titleFor(v, o);
  const purpose = fill(vd.purpose, o);
  const chainTo = chainLinkFor(id(v, o));

  const whenLines = pickN(WHENS, 5).map((w) => `- Use this when ${w}.`).join("\n");
  const preLines = pickN(PRECONDS, 5).map((p) => `- [ ] ${p}`).join("\n");

  // 3-6 DISTINCT, completable procedure steps (one tool action each), each
  // stem + two detail sentences. Every verb is authored with exactly 4
  // stepStems (a coherent, non-repeating sequence) -> stepCount is always
  // within [3,6]. Was 16-21 steps cycling the SAME 4 stems (near-duplicates,
  // e.g. "Intake refund..." repeated 5x to fill 20 "steps") -- the judge
  // requires EVERY numbered step to have a corresponding tool action, so a
  // 16-21-near-duplicate-step procedure made followed=true unreachable by any
  // strategy under load (H1 dry run scored 0/2; see README increment-2
  // evidence). Shortening to the authored, distinct stem set makes the floor
  // genuinely reachable while keeping each step concrete and actionable.
  //
  // Deliberately BARE single-line steps (no elaboration sub-bullets): an early
  // version kept 2 generic "detail" bullets per step (leftover from when 16-21
  // steps needed disguising as non-repeats). A live gpt-5.1 judge run against
  // that shape still scored followed=false on a fully-adherent transcript,
  // reading the (randomly-paired, often off-topic) detail bullets as ADDITIONAL
  // required checks needing their OWN tool evidence, even though the judge
  // prompt only requires evidence for "numbered steps" -- e.g. it faulted a
  // complete refund transcript for not separately "capturing before/after line
  // items" or "re-reading the ledger", text that only ever lived in a sub-bullet,
  // never in the numbered step itself. `fixtures/index.ts` (which the judge
  // scores correctly, per AC5) uses exactly this bare single-line-step shape;
  // matching it removes the ambiguity at the source instead of reinterpreting
  // the judge prompt (kept the ballgame narrowly in generate-corpus.ts).
  const stepCount = vd.stepStems.length;
  const steps: string[] = [];
  for (let i = 0; i < stepCount; i++) {
    const stem = fill(vd.stepStems[i], o);
    steps.push(`${i + 1}. ${stem[0].toUpperCase()}${stem.slice(1)}.`);
  }
  // Authored transitive-chain hand-off — kept OUT of the numbered steps (in a
  // dedicated "## Follow-on procedures" section below) so a judge scores this
  // procedure on its OWN steps and chain completion is tracked separately.
  const hasChain = Boolean(chainTo && ID_SET.has(chainTo));

  const failureLines = pickN(FAILURES, 6).map((f) => `- Watch for the case where ${f}; if it occurs, stop and follow the rollback section.`).join("\n");
  const inputLines = od.artifacts.map((a) => `- ${a[0].toUpperCase()}${a.slice(1)}`).join("\n");
  const notes: string[] = sampleN(NOTES, 8).map((n) => `- ${n}`);

  const sections = [
    `# ${title}`,
    "",
    "## Purpose",
    `This procedure describes how to ${purpose}. It exists so the operation is performed the same, safe way every time, regardless of who runs it, and so that a fresh operator can carry it out from the written steps alone.`,
    "",
    "## When this applies",
    whenLines,
    "",
    "## Preconditions",
    preLines,
    "",
    "## Inputs and outputs",
    `This procedure reads and writes the following around ${od.noun}:`,
    inputLines,
    "",
    "## Procedure",
    steps.join("\n"),
    "",
    "## Verification",
    `Confirm ${od.signal} is within its expected bound and that ${pick(od.artifacts)} reflects the intended end state. Re-run the checks once more after a short settle period; a single green reading is not sufficient for an irreversible operation. Where possible, verify against the live state of ${pick(od.systems)} rather than a cached copy.`,
    "",
    "## Failure modes",
    failureLines,
    "",
    "## Rollback and recovery",
    `If the operation must be undone, restore ${pick(od.artifacts)} from the recovery point identified in the preconditions, reattach ${od.noun} to ${pick(od.systems)}, and confirm ${od.signal} returns to baseline. Never leave ${od.noun} in a half-applied state; a clean revert is always preferable to a partially completed operation left for someone else to untangle.`,
    "",
    "## Escalation",
    `If you cannot complete this procedure, or you observe impact beyond ${od.noun}, follow procedure \`escalate-ticket\` to route the issue to the right responder without delay. Do not keep retrying a step that has failed twice for the same reason.`,
    "",
    ...(hasChain
      ? [
          "## Follow-on procedures",
          `After the steps above are complete, follow procedure \`${chainTo}\` to carry out the required follow-on work. This is a transitive hand-off: the wider task is not finished until \`${chainTo}\` has also been completed in full.`,
          "",
        ]
      : []),
    "## Related procedures",
    links.map((l) => `- \`${l}\``).join("\n"),
    "",
    "## Notes and edge cases",
    notes.join("\n"),
    "",
  ];

  // Padding: append additional-considerations paragraphs (unbounded) so the
  // corpus can be grown to the token target deterministically.
  if (padRounds > 0) {
    sections.push("## Additional considerations");
    for (let r = 0; r < padRounds; r++) {
      sections.push(fillerParagraph(o, 5));
      sections.push("");
    }
  }

  return sections.join("\n");
}

function frontmatter(fields: {
  id: string;
  keywords: string[];
  links: string[];
  status: string;
}): string {
  return [
    "---",
    `id: ${fields.id}`,
    "kind: procedure",
    `keywords: [${fields.keywords.join(", ")}]`,
    `links: [${fields.links.join(", ")}]`,
    `status: ${fields.status}`,
    "---",
    "",
  ].join("\n");
}

function keywordsFor(v: string, o: string): string[] {
  const base = [v, OBJECTS[o].noun.split(" ")[0], o];
  const extra = pickN(["operation", "procedure", "runbook", "controlled", "reversible", "audited", "safety", "recovery"], 3);
  return Array.from(new Set([...base, ...extra]));
}

function linksFor(v: string, o: string): string[] {
  const links = new Set<string>();
  const chainTo = chainLinkFor(id(v, o));
  if (chainTo) links.add(chainTo);
  links.add("escalate-ticket");
  // 2 related, deterministic, existing, not self.
  for (const l of pickN(ALL_IDS, 4)) {
    if (l !== id(v, o)) links.add(l);
    if (links.size >= 4) break;
  }
  return [...links];
}

function metaProcedure(): { path: string; content: string; keywords: string[]; links: string[] } {
  const keywords = ["author", "procedure", "adopt", "meta", "runbook", "status", "active"];
  const links = ["publish-policy", "review-policy", "escalate-ticket"];
  const body = [
    "# Author and Adopt a New Procedure",
    "",
    "## Purpose",
    "This meta-procedure describes how to write a new procedure and adopt it into the corpus so that future operators follow it automatically. Use it whenever a repeated operation lacks a written procedure, or when a gap is discovered during an incident.",
    "",
    "## When this applies",
    "- Use this when the same operation has been performed ad hoc more than once.",
    "- Use this when a review or incident identifies a missing or unclear procedure.",
    "- Use this when an existing procedure must be superseded by a corrected one.",
    "",
    "## Preconditions",
    "- [ ] The operation is well enough understood to write down repeatable steps.",
    "- [ ] A neutral, unambiguous id has been chosen (verb-object, lowercase).",
    "- [ ] The intended links to related procedures are known.",
    "",
    "## Procedure",
    "1. Create a new file at `corpus/<id>/PROCEDURE.md`.",
    "2. Add frontmatter with `id`, `kind: procedure`, `keywords`, `links`, and `status: draft`.",
    "3. Write the body: Purpose, When this applies, Preconditions, Procedure, Verification, Rollback and recovery, Escalation, Related procedures.",
    "4. Keep every step concrete and reversible; each step should map to an observable action.",
    "5. Link the new procedure from any procedure that should hand off to it, and add its id to their `links`.",
    "6. Once reviewed, change `status: draft` to `status: active` so it becomes binding.",
    "7. Announce the new procedure so operators know to follow it.",
    "",
    "## Verification",
    "Confirm the new file parses (valid frontmatter), its `links` resolve to existing ids, and its `status` is `active`. A fresh operator, given only the corpus, should be able to follow it without further explanation.",
    "",
    "## Rollback and recovery",
    "If a newly adopted procedure proves wrong, set its `status` to `deprecated`, restore the previous guidance, and follow `review-policy` to decide the corrected form.",
    "",
    "## Escalation",
    "If there is disagreement about whether a procedure should be adopted, follow `escalate-ticket` to route the decision.",
    "",
    "## Related procedures",
    "- `publish-policy`",
    "- `review-policy`",
    "- `escalate-ticket`",
    "",
  ].join("\n");
  return {
    path: `corpus/${META_ID}/PROCEDURE.md`,
    content: frontmatter({ id: META_ID, keywords, links, status: "active" }) + body,
    keywords,
    links,
  };
}

// --- main -------------------------------------------------------------------
function main(): void {
  rng = mulberry32(SEED); // reset for determinism
  rmSync(CORPUS_DIR, { recursive: true, force: true });
  mkdirSync(CORPUS_DIR, { recursive: true });

  interface Built {
    id: string;
    path: string;
    content: string;
    keywords: string[];
    links: string[];
    status: string;
    tokens: number;
  }
  const built: Built[] = [];

  const emit = (
    procId: string,
    relPath: string,
    content: string,
    keywords: string[],
    links: string[],
    status: string,
  ) => {
    if (BANNED.test(content)) {
      throw new Error(`BANNED TERM in ${procId}: ${BANNED.exec(content)?.[0]}`);
    }
    const tokens = encode(content).length;
    built.push({ id: procId, path: relPath, content, keywords, links, status, tokens });
  };

  // Regular procedures.
  for (const [v, o] of PAIRS) {
    const procId = id(v, o);
    if (built.some((b) => b.id === procId)) continue; // dedupe
    const keywords = keywordsFor(v, o);
    const links = linksFor(v, o);
    const body = buildBody(v, o, links, 0);
    const content = frontmatter({ id: procId, keywords, links, status: "active" }) + body;
    emit(procId, `corpus/${procId}/PROCEDURE.md`, content, keywords, links, "active");
  }

  // Meta-procedure.
  const meta = metaProcedure();
  emit(META_ID, meta.path, meta.content, meta.keywords, meta.links, "active");

  // Token budget: pad bodies (Notes section) deterministically until >= target.
  let total = built.reduce((s, b) => s + b.tokens, 0);
  let pad = 0;
  while (total < TOKEN_TARGET && pad < 40) {
    pad++;
    rng = mulberry32(SEED + pad); // fresh stream per pad round, still deterministic
    for (const b of built) {
      if (b.id === META_ID) continue;
      const [v, o] = b.id.split("-") as [string, string];
      if (!VERBS[v] || !OBJECTS[o]) continue;
      const body = buildBody(v, o, b.links, pad); // more notes each round
      b.content = frontmatter({ id: b.id, keywords: b.keywords, links: b.links, status: b.status }) + body;
      if (BANNED.test(b.content)) throw new Error(`BANNED TERM after pad in ${b.id}`);
      b.tokens = encode(b.content).length;
    }
    total = built.reduce((s, b) => s + b.tokens, 0);
  }

  // Write files.
  for (const b of built) {
    const abs = join(HERE, b.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, b.content, "utf8");
  }

  // Manifest.
  const manifest: CorpusManifest = {
    generatedAt: new Date(0).toISOString(), // fixed for deterministic diff
    seed: SEED,
    tokenizer: TOKENIZER,
    totalTokens: total,
    fileCount: built.length,
    metaProcedureId: META_ID,
    procedures: built.map((b) => ({
      id: b.id,
      path: b.path,
      keywords: b.keywords,
      links: b.links,
      status: b.status,
      tokens: b.tokens,
    })),
    chains: CHAINS,
    scenarios: SCENARIOS,
  };
  writeFileSync(join(CORPUS_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  // Validate chain integrity: every chain step must exist as a generated file.
  const idsOnDisk = new Set(built.map((b) => b.id));
  for (const c of CHAINS) {
    for (const step of c.steps) {
      if (!idsOnDisk.has(step)) throw new Error(`Chain ${c.root} references missing procedure ${step}`);
    }
  }

  process.stdout.write(
    [
      `corpus generated: ${built.length} files, ${total} tokens (${TOKENIZER}), padRounds=${pad}`,
      `chains: ${CHAINS.length} (e.g. ${CHAINS[0].steps.join(" -> ")})`,
      `meta-procedure: ${META_ID}`,
      `manifest: ${join(CORPUS_DIR, "manifest.json")}`,
      "",
    ].join("\n"),
  );
}

main();
