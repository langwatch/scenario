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

/**
 * Safely formats content for logging, masking binary data
 */
function formatContentForLogging(content: unknown): string {
  if (typeof content !== "string") {
    return "[Non-text content]";
  }

  // Check if content looks like base64 (common pattern for binary data)
  if (/^[A-Za-z0-9+/]+=*$/.test(content) && content.length > 50) {
    return "[Binary data]";
  }

  // Try to parse as JSON and check for binary content
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      // Check if array contains file parts with binary data
      const hasBinaryData = parsed.some(
        (part) =>
          part?.type === "file" &&
          part?.data &&
          typeof part.data === "string" &&
          /^[A-Za-z0-9+/]+=*$/.test(part.data) &&
          part.data.length > 50
      );
      if (hasBinaryData) {
        return "[Content with binary data]";
      }
    }
  } catch {
    // Not JSON, continue with original content
  }

  // Safe to display, but limit length
  return content.length > 100 ? `${content.slice(0, 100)}...` : content;
}

function indent(str: string, n: number = 2) {
  return str.replace(/^/gm, " ".repeat(n));
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
      let bucket = runs.get(runId);
      if (!bucket) {
        bucket = [];
        runs.set(runId, bucket);
      }
      bucket.push(event);
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
        console.log("Chat log:\n");
        let lastMessageCount = 0;
        for (const msg of messages) {
          const allMessages =
            (msg as { messages?: { role: string; content: string }[] })
              .messages ?? [];

          // Only print new messages
          for (const m of allMessages.slice(lastMessageCount)) {
            const role = m.role;

            if (
              role.toLowerCase() === "assistant" &&
              "toolCalls" in m &&
              Array.isArray(m.toolCalls) &&
              m.toolCalls.length > 0
            ) {
              for (const toolCall of m.toolCalls) {
                const functionName = toolCall.function.name;
                let parsedJson = "";
                try {
                  parsedJson = JSON.stringify(
                    JSON.parse(toolCall.function.arguments),
                    null,
                    2
                  );
                } catch {
                  parsedJson = toolCall.function.arguments;
                }
                const role = chalk.magenta(`ToolCall(${functionName}):`);
                console.log(`${role}:\n\n${indent(parsedJson)}\n`);
              }
              continue;
            }

            let roleLabel = role;
            if (role.toLowerCase() === "user") roleLabel = chalk.green("User");
            else if (role.toLowerCase() === "agent")
              roleLabel = chalk.cyan("Agent");
            else if (role.toLowerCase() === "assistant")
              if (
                Array.isArray(m.content) &&
                typeof m.content.at(0) === "object" &&
                (m.content.at(0) as unknown as { type: string })?.type ===
                  "tool-call"
              )
                roleLabel = chalk.cyan("ToolCall");
              else roleLabel = chalk.cyan("Assistant");
            else if (role.toLowerCase() === "tool") {
              roleLabel = chalk.magenta("ToolResult");
              let parsedJson = "";
              try {
                parsedJson = JSON.stringify(JSON.parse(m.content), null, 2);
              } catch {
                parsedJson = m.content;
              }
              console.log(`${roleLabel}:\n\n${indent(parsedJson)}\n`);
              continue;
            } else roleLabel = chalk.yellow(role);

            console.log(`${roleLabel}: ${formatContentForLogging(m.content)}`);
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
    console.log(
      passed > 0 ? chalk.green(`Passed: ${passed}`) : `Passed: ${passed}`
    );
    console.log(
      failed > 0 ? chalk.red(`Failed: ${failed}`) : `Failed: ${failed}`
    );
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
