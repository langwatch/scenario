import chalk from "chalk";

// Need to import these types for the type guards
import {
  ScenarioResult,
  Verdict,
} from "../types";

/**
 * Formats and prints a scenario test result in a visually appealing way
 * @param result The scenario test result to format
 */
export function formatScenarioResult(result: ScenarioResult) {
  printHeader();
  printVerdict(result.verdict);
  printReasoning(result.reasoning);

  if (isFinishTestResponse(result)) {
    printCriteria(result);
  }

  printFooter();
}

/**
 * Prints the header for the test results
 */
function printHeader() {
  process.stdout.write(chalk.bold("\n==================================\n"));
  process.stdout.write("\n" + chalk.bold("=== Scenario Test Results ===\n\n"));
}

/**
 * Prints the verdict (pass/fail) of the test
 * @param verdict The test verdict
 */
function printVerdict(verdict: Verdict) {
  const status = verdict === Verdict.Success ? "✅ PASSED" : "❌ FAILED";
  process.stdout.write(chalk.bold(status + "\n\n"));
}

/**
 * Prints the reasoning for the test result
 * @param reasoning The reasoning text
 */
function printReasoning(reasoning: string | null) {
  if (reasoning) {
    process.stdout.write(chalk.bold("Reasoning: ") + reasoning + "\n\n");
  }
}

/**
 * Prints all criteria results (met, unmet, and failures)
 * @param result The test result containing criteria information
 */
function printCriteria(result: ScenarioResult) {
  printMetCriteria(result.metCriteria);
  printUnmetCriteria(result.unmetCriteria);
  printTriggeredFailures(result.triggeredFailures);
}

/**
 * Prints the list of criteria that were met
 * @param criteria Array of met criteria
 */
function printMetCriteria(criteria: string[]) {
  if (criteria && criteria.length > 0) {
    process.stdout.write(chalk.green.bold("✓ Met Criteria:\n"));
    criteria.forEach((criterion: string) => {
      process.stdout.write(chalk.green("  • " + criterion + "\n"));
    });
    process.stdout.write("\n");
  }
}

/**
 * Prints the list of criteria that were not met
 * @param criteria Array of unmet criteria
 */
function printUnmetCriteria(criteria: string[]) {
  if (criteria && criteria.length > 0) {
    process.stdout.write(chalk.yellow.bold("⚠ Unmet Criteria:\n"));
    criteria.forEach((criterion: string) => {
      process.stdout.write(chalk.yellow("  • " + criterion + "\n"));
    });
    process.stdout.write("\n");
  }
}

/**
 * Prints the list of failure criteria that were triggered
 * @param failures Array of triggered failures
 */
function printTriggeredFailures(failures: string[]) {
  if (failures && failures.length > 0) {
    process.stdout.write(chalk.red.bold("✗ Triggered Failures:\n"));
    failures.forEach((failure: string) => {
      process.stdout.write(chalk.red("  • " + failure + "\n"));
    });
    process.stdout.write("\n");
  }
}

/**
 * Prints the footer for the test results
 */
function printFooter() {
  process.stdout.write(chalk.bold("\n==================================\n\n"));
}

/**
 * Type guard to check if the result is a ScenarioResult result
 * @param result The scenario result to check
 */
function isFinishTestResponse(
  result: ScenarioResult
): result is ScenarioResult {
  return (
    "verdict" in result
  );
}

