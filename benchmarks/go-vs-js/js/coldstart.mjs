// Cold start, ESM: import the built SDK (dist/index.mjs), set up tracing,
// run the trivial scenario once, print the peak RSS, exit. The driver
// (coldstart-driver.mjs) times the whole process from the outside; the twin
// is go/cmd/coldstart.
import { runTrivial, setup } from "./lib/setup.mjs";
import { maxRssBytes } from "./lib/stats.mjs";

const env = await setup();
await runTrivial(env);
process.stdout.write(JSON.stringify({ maxrss_bytes: maxRssBytes() }) + "\n");
// Exit like the Go binary does once main returns, without waiting for
// idle handles (keep-alive sockets, timers) to close on their own.
process.exit(0);
