// Times whole-process cold starts: the Go binary, node + ESM build, node +
// CJS build. Each target runs once untimed (page cache, macOS binary
// scanning), then --reps times, interleaved in a rotating order so slow
// drift of the machine hits all three alike. Wall time is measured here,
// around spawnSync; peak RSS is what each child reports for itself.
//
//   node coldstart-driver.mjs --go-bin=PATH --reps=40 --out=FILE
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nowMs, parseArgs, summarize, writeJson } from "./lib/stats.mjs";

const args = parseArgs();
const here = path.dirname(fileURLToPath(import.meta.url));
const reps = Number(args.reps ?? 40);
if (!args["go-bin"]) throw new Error("--go-bin is required");

const targets = [
  { name: "go", cmd: path.resolve(args["go-bin"]), argv: [] },
  { name: "js_esm", cmd: process.execPath, argv: [path.join(here, "coldstart.mjs")] },
  { name: "js_cjs", cmd: process.execPath, argv: [path.join(here, "coldstart.cjs")] },
];

function once(t) {
  const start = nowMs();
  const r = spawnSync(t.cmd, t.argv, { encoding: "utf8", env: process.env });
  const wall = nowMs() - start;
  if (r.status !== 0) {
    throw new Error(`${t.name} exited with ${r.status}: ${r.stderr || r.error}`);
  }
  const line = r.stdout.trim().split("\n").pop();
  return { wall, rss: JSON.parse(line).maxrss_bytes };
}

const samples = Object.fromEntries(targets.map((t) => [t.name, { wall: [], rss: [] }]));
for (const t of targets) once(t);
for (let i = 0; i < reps; i++) {
  for (let k = 0; k < targets.length; k++) {
    const t = targets[(i + k) % targets.length];
    const s = once(t);
    samples[t.name].wall.push(s.wall);
    samples[t.name].rss.push(s.rss);
  }
}

const doc = { reps, node_version: process.version };
for (const t of targets) {
  doc[t.name] = { wall_ms: summarize(samples[t.name].wall), maxrss_bytes: summarize(samples[t.name].rss) };
}
writeJson(args.out, doc);
