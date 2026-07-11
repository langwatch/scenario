/**
 * prove-ac1 — AC1 evidence, ZERO subscription cost.
 *
 * Independently re-measures the ON-DISK corpus (does not trust the generator's
 * in-memory figure) and prints the three gates:
 *   1. real-tokenizer total  > 200,000
 *   2. manifest shows        >= 1 authored A->B chain
 *   3. banned-term grep      == 0  (internal/proprietary vocabulary blocklist)
 *
 * Run:  tsx prove-ac1.ts
 */

import { readFileSync } from "node:fs";

import { encode } from "gpt-tokenizer";

import { CORPUS_DIR, corpusFiles, loadManifest } from "./corpus-loader.ts";

const BANNED = new RegExp(process.env.ADHERENCE_BANNED_TERMS ?? "langwatch|acme-internal", "i");
const TOKEN_GATE = 200_000;

function main(): void {
  const files = corpusFiles();
  if (files.length === 0) {
    console.error(`No corpus at ${CORPUS_DIR}. Run: tsx generate-corpus.ts`);
    process.exit(1);
  }

  // 1. Independent real-tokenizer count over on-disk files.
  let totalTokens = 0;
  const bannedHits: string[] = [];
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    totalTokens += encode(raw).length;
    const m = BANNED.exec(raw);
    if (m) bannedHits.push(`${file}: "${m[0]}"`);
  }

  // 2. Manifest chains.
  const manifest = loadManifest();
  const chains = manifest.chains ?? [];

  const gate1 = totalTokens > TOKEN_GATE;
  const gate2 = chains.length >= 1;
  const gate3 = bannedHits.length === 0;

  console.log("================ AC1 — Corpus past the stuffing threshold ================");
  console.log(`files on disk .................. ${files.length}`);
  console.log(`REAL tokenizer .............. ${manifest.tokenizer} (independent re-count on disk)`);
  console.log(`REAL token total ............ ${totalTokens.toLocaleString()}  (gate: > ${TOKEN_GATE.toLocaleString()})   ${gate1 ? "PASS" : "FAIL"}`);
  console.log(`manifest.totalTokens ........ ${manifest.totalTokens.toLocaleString()}  (generator's own count)`);
  console.log("");
  console.log(`A->B chains in manifest ..... ${chains.length}   (gate: >= 1)   ${gate2 ? "PASS" : "FAIL"}`);
  for (const c of chains) {
    console.log(`   chain root ${c.root.padEnd(18)} : ${c.steps.join(" -> ")}`);
  }
  console.log(`   meta-procedure .......... ${manifest.metaProcedureId}`);
  console.log("");
  console.log(`banned-term matches ......... ${bannedHits.length}   (gate: == 0)   ${gate3 ? "PASS" : "FAIL"}`);
  console.log(`   pattern: /${BANNED.source}/i`);
  if (bannedHits.length) bannedHits.slice(0, 10).forEach((h) => console.log(`   HIT ${h}`));
  console.log("");

  const pass = gate1 && gate2 && gate3;
  console.log(`AC1 VERDICT: ${pass ? "PASS (all three gates)" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
}

main();
