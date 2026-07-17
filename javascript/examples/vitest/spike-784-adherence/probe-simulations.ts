/**
 * probe-simulations — DATA GATE A (owner HOLD, #784): prove scenario-native run
 * reporting REACHES LangWatch simulations under setId `spike-784-adherence` AND is
 * QUERYABLE BACK — not just wired. A cheap mock run (OpenAI user-sim only, NO Max
 * bucket, NO claude -p subject): posts one simulation batch, prints its batchRunId.
 *
 * The KEY fix it validates: post with the SAME LangWatch key the query-back tool
 * (the LangWatch MCP) reads from, so the run lands in a queryable project. The
 * predecessor posted with a different-project key (voice-bugbash) than the MCP
 * reads (returns none) — that was the "simulations UI empty / can't query back" gap.
 *
 *   LANGWATCH_API_KEY=<mcp-project sk-lw key>  OPENAI_API_KEY=<...>  tsx probe-simulations.ts
 *
 * Then query back:  platform_list_simulation_runs(scenarioSetId="spike-784-adherence").
 */
import { readFileSync } from "node:fs";

import scenario, { AgentRole, type AgentAdapter } from "@langwatch/scenario";
import { openai } from "@ai-sdk/openai";

const SET_ID = "spike-784-adherence";
const OPENAI_ENV_PATH =
  process.env.ADHERENCE_OPENAI_ENV ?? "/home/ubuntu/langwatch-workspace/scenario-050-repro/.env";

function loadOpenAIKey(): string | undefined {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const line = readFileSync(OPENAI_ENV_PATH, "utf8")
      .split("\n")
      .find((l) => l.startsWith("OPENAI_API_KEY="));
    const key = line?.slice("OPENAI_API_KEY=".length).replace(/^["']|["']$/g, "").trim();
    if (key) process.env.OPENAI_API_KEY = key;
    return key;
  } catch {
    return undefined;
  }
}

const probeAgent: AgentAdapter = {
  role: AgentRole.AGENT,
  call: async () =>
    "Understood — I've received the vendor onboarding request and will provision the account and grant access.",
};

async function main(): Promise<void> {
  const openaiKey = loadOpenAIKey();
  const lwKeyLen = (process.env.LANGWATCH_API_KEY ?? "").length;
  console.log(
    `probe: setId=${SET_ID}  LANGWATCH_API_KEY present=${lwKeyLen > 0 ? `yes(len${lwKeyLen})` : "NO"}  OPENAI present=${openaiKey ? "yes" : "NO"}`,
  );
  if (!lwKeyLen) throw new Error("LANGWATCH_API_KEY not set — cannot post to simulations (Gate A needs it)");
  if (!openaiKey) throw new Error("OPENAI_API_KEY not found — the user simulator needs it");

  const result = await scenario.run({
    name: "sc784 simulations query-back probe",
    description:
      "DATA-GATE-A plumbing probe: confirm scenario-native run reporting reaches LangWatch simulations under setId spike-784-adherence and is queryable back via the MCP.",
    agents: [probeAgent, scenario.userSimulatorAgent({ model: openai("gpt-5-mini") })],
    script: [scenario.user("I need to onboard a new vendor."), scenario.agent(), scenario.succeed()],
    setId: SET_ID,
  });

  // Surface whatever run/batch identifiers the SDK exposes for query-back matching.
  const ids = {
    success: result.success,
    batchRunId:
      (result as unknown as { batchRunId?: string }).batchRunId ??
      process.env.SCENARIO_BATCH_RUN_ID ??
      "(not surfaced on result)",
  };
  console.log("PROBE_RESULT", JSON.stringify(ids));
  console.log("DONE_MARKER probe-simulations");
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
