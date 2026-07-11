/**
 * corpus-loader — parse the generated `corpus/` back into an in-memory
 * {@link CorpusIndex} + {@link CorpusManifest}. Used by the AC1 proof (to
 * independently re-measure the ON-DISK corpus, not trust the generator's
 * in-memory count) and by the later live run (to give the judge procedure
 * bodies).
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CorpusIndex, CorpusManifest, ProcedureEntry } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CORPUS_DIR = join(HERE, "corpus");

interface Frontmatter {
  id: string;
  kind: string;
  keywords: string[];
  links: string[];
  status: string;
}

function parseList(v: string): string[] {
  return v
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Split `---`-fenced frontmatter from the body. */
export function parseFrontmatter(raw: string): { fm: Frontmatter; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new Error("no frontmatter");
  const fm: Record<string, string | string[]> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, k, v] = kv;
    fm[k] = k === "keywords" || k === "links" ? parseList(v) : v;
  }
  return {
    fm: {
      id: String(fm.id ?? ""),
      kind: String(fm.kind ?? ""),
      keywords: (fm.keywords as string[]) ?? [],
      links: (fm.links as string[]) ?? [],
      status: String(fm.status ?? ""),
    },
    body: m[2],
  };
}

/** Every `corpus/<id>/PROCEDURE.md` path on disk. */
export function corpusFiles(dir = CORPUS_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(dir, d.name, "PROCEDURE.md"))
    .filter((p) => existsSync(p));
}

/** Load the corpus into an id -> {@link ProcedureEntry} index (body = markdown after frontmatter). */
export function loadCorpus(dir = CORPUS_DIR): CorpusIndex {
  const index: CorpusIndex = new Map();
  for (const file of corpusFiles(dir)) {
    const raw = readFileSync(file, "utf8");
    const { fm, body } = parseFrontmatter(raw);
    const rel = file.slice(file.indexOf("corpus/"));
    const entry: ProcedureEntry = {
      id: fm.id,
      path: rel,
      kind: "procedure",
      title: (/^#\s+(.+)$/m.exec(body)?.[1] ?? fm.id).trim(),
      keywords: fm.keywords,
      links: fm.links,
      status: (fm.status as ProcedureEntry["status"]) || "active",
      body,
      tokens: 0,
    };
    index.set(entry.id, entry);
  }
  return index;
}

export function loadManifest(dir = CORPUS_DIR): CorpusManifest {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as CorpusManifest;
}
