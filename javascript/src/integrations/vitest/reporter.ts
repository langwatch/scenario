import fs from "fs";
import path from "path";
import chalk from "chalk";
import type { TestCase, Reporter } from "vitest/node";
import type {
  ScenarioEvent,
  ScenarioRunStartedEvent,
  ScenarioRunFinishedEvent,
  ScenarioMessageSnapshotEvent,
} from "../../events/schema";
import { Logger } from "../../utils/logger";

const logger = Logger.create("integrations:vitest:reporter");

function getProjectRoot() {
  return process.cwd();
}

const projectRoot = getProjectRoot();
const logDir = path.join(projectRoot, ".scenario");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

function getLogFilePath(testId: string) {
  return path.join(logDir, `${testId}.log`);
}

interface SuiteLike {
  name: string;
  suite?: SuiteLike;
}

function getFullTestName(task: { name: string; suite?: SuiteLike }): string {
  let name = task.name;
  let parent = task.suite;
  while (parent) {
    name = `${parent.name} > ${name}`;
    parent = parent.suite;
  }
  return name;
}

class VitestReporter implements Reporter {
  private results: Array<{
    name: string;
    status: string;
    duration: number;
    reasoning?: string;
    criteria?: string;
  }> = [];

  async onTestCaseResult(test: TestCase) {
    const fullName = getFullTestName(test);
    const filePath = getLogFilePath(test.id);
    if (!fs.existsSync(filePath)) {
      logger.warn(
        `No log file found ${filePath} for test ${fullName}`,
        test.id
      );
      return;
    }
    const lines = fs
      .readFileSync(filePath, "utf-8")
      .split("\n")
      .filter(Boolean);
    const events: ScenarioEvent[] = lines.map((line) => JSON.parse(line));

    // Group events by scenarioRunId
    const runs = new Map<string, ScenarioEvent[]>();
    for (const event of events) {
      const runId =
        (event as { scenarioRunId?: string }).scenarioRunId ?? "unknown";
      if (!runs.has(runId)) runs.set(runId, []);
      runs.get(runId)!.push(event);
    }

    for (const [runId, runEvents] of Array.from(runs.entries())) {
      const started = runEvents.find(
        (e) => e.type === "SCENARIO_RUN_STARTED"
      ) as ScenarioRunStartedEvent | undefined;
      const finished = runEvents.find(
        (e) => e.type === "SCENARIO_RUN_FINISHED"
      ) as ScenarioRunFinishedEvent | undefined;
      const messages = runEvents.filter(
        (e) => e.type === "SCENARIO_MESSAGE_SNAPSHOT"
      ) as ScenarioMessageSnapshotEvent[];

      // Collect summary info for the report
      this.results.push({
        name: started?.metadata?.name ?? fullName,
        status: finished?.status ?? "UNKNOWN",
        duration:
          started && finished ? finished.timestamp - started.timestamp : 0,
        reasoning: finished?.results?.reasoning,
        criteria: finished?.results
          ? `Success Criteria: ${finished.results.metCriteria?.length ?? 0}/${
              (finished.results.metCriteria?.length ?? 0) +
              (finished.results.unmetCriteria?.length ?? 0)
            }`
          : undefined,
      });

      // Existing detailed output (optional, can be removed if only summary is needed)
      console.log(
        `\n--- Scenario Run: ${started?.metadata?.name ?? runId} ---`
      );
      if (started) {
        console.log(`Description: ${started.metadata?.description ?? ""}`);
      }

      if (messages.length) {
        console.log("Chat log:");
        let lastMessageCount = 0;
        for (const msg of messages) {
          const allMessages =
            (msg as { messages?: { role: string; content: string }[] })
              .messages ?? [];

          // Only print new messages
          for (const m of allMessages.slice(lastMessageCount)) {
            const role = m.role;
            let roleLabel = role;
            if (role.toLowerCase() === "user") roleLabel = chalk.green("User");
            else if (role.toLowerCase() === "agent")
              roleLabel = chalk.cyan("Agent");
            else if (role.toLowerCase() === "assistant")
              roleLabel = chalk.cyan("Assistant");
            else roleLabel = chalk.yellow(role);
            console.log(`${roleLabel}: ${m.content}`);
          }
          lastMessageCount = allMessages.length;
        }
      }
      if (finished) {
        console.log("--- Verdict ---");
        console.log(`Status: ${finished.status}`);

        if (finished.results) {
          console.log(`Verdict: ${finished.results.verdict}`);
          if (finished.results.reasoning)
            console.log(`Reasoning: ${finished.results.reasoning}`);
          if (finished.results.metCriteria?.length)
            console.log(
              `Met criteria: ${finished.results.metCriteria.join(", ")}`
            );
          if (finished.results.unmetCriteria?.length)
            console.log(
              `Unmet criteria: ${finished.results.unmetCriteria.join(", ")}`
            );
          if (finished.results.error)
            console.log(`Error: ${finished.results.error}`);
        }
      }
      console.log("-----------------------------\n");
    }

    // Clean up the log file
    fs.unlinkSync(filePath);
  }

  async onTestRunEnd() {
    // Print scenario test summary report
    if (this.results.length === 0) return;
    const total = this.results.length;
    const passed = this.results.filter((r) => r.status === "SUCCESS").length;
    const failed = this.results.filter((r) => r.status !== "SUCCESS").length;
    const successRate = ((passed / total) * 100).toFixed(1);

    console.log();
    console.log(chalk.bold.cyan("=== Scenario Test Report ==="));
    console.log(`Total Scenarios: ${total}`);
    console.log(chalk.green(`Passed: ${passed}`));
    console.log(chalk.red(`Failed: ${failed}`));
    console.log(`Success Rate: ${chalk.bold(`${successRate}%`)}`);

    this.results.forEach((r, i) => {
      const statusColor = r.status === "SUCCESS" ? chalk.green : chalk.red;

      console.log();
      console.log(
        `${i + 1}. ${r.name} - ${statusColor(r.status)} in ${(
          r.duration / 1000
        ).toFixed(2)}s`
      );

      if (r.reasoning) {
        console.log(chalk.greenBright("  Reasoning: ") + r.reasoning);
      }

      if (r.criteria) {
        console.log(chalk.bold("  " + r.criteria));
      }
    });
    console.log();
  }
}

export default VitestReporter;
