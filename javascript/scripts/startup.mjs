import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const entry = resolve(process.argv[2] ?? fileURLToPath(new URL("../dist/index.js", import.meta.url)));
const samples = Number(process.argv[3] ?? 7);
if (!Number.isSafeInteger(samples) || samples < 1) {
  throw new Error("The sample count must be a positive integer");
}

const probe = `
  const { performance } = require('node:perf_hooks');
  const before = process.memoryUsage().rss;
  const start = performance.now();
  require(process.argv[1]);
  console.log(JSON.stringify({
    ms: performance.now() - start,
    rssBytes: process.memoryUsage().rss - before,
    modules: Object.keys(require.cache).length,
  }));
`;
const results = Array.from({ length: samples }, () => JSON.parse(
  execFileSync(process.execPath, ["-e", probe, entry], { encoding: "utf8" }),
));
const median = (key) => {
  const values = results.map((sample) => sample[key]).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
};
console.log(JSON.stringify({
  node: process.version,
  entry,
  samples,
  medianMs: median("ms"),
  medianRssBytes: median("rssBytes"),
  modules: median("modules"),
  results,
}, null, 2));
