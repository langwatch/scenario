import {
  AssistantContent,
  ToolContent,
  CoreMessage,
} from "ai";
import { allAgentRoles, AgentRole, ScenarioConfig, ScenarioResult } from "../domain";
import { ScenarioExecution } from "../scenario-execution";
import { proceed } from "../script";
import { generateThreadId } from "../utils/ids";


export async function run(cfg: ScenarioConfig): Promise<ScenarioResult> {
  if (!cfg.name) {
    throw new Error("Scenario name is required");
  }
  if (!cfg.description) {
    throw new Error("Scenario description is required");
  }
  if ((cfg.maxTurns || 10) < 1) {
    throw new Error("Max turns must be at least 1");
  }
  if (cfg.agents.length === 0) {
    throw new Error("At least one agent is required");
  }
  if (!cfg.agents.find(agent => agent.role === AgentRole.AGENT)) {
    throw new Error("At least one non-user/non-judge agent is required");
  }

  cfg.agents.forEach((agent, i) => {
    if (!allAgentRoles.includes(agent.role)) {
      throw new Error(`Agent ${i} has invalid role: ${agent.role}`);
    }
  });

  if (!cfg.threadId) {
    cfg.threadId = generateThreadId();
  }

  const steps = cfg.script || [proceed()];
  const execution = new ScenarioExecution(
    cfg,
    steps,
  );

  const result = await execution.execute();
  if (cfg.verbose && !result.success) {
    console.log(`Scenario failed: ${cfg.name}`);
    console.log(`Reasoning: ${result.reasoning}`);
    console.log('--------------------------------');
    console.log(`Passed criteria: ${result.passedCriteria.join("\n- ")}`);
    console.log(`Failed criteria: ${result.failedCriteria.join("\n- ")}`);
    console.log(result.messages.map(formatMessage).join("\n"));
  }

  return result;
}

function formatMessage(m: CoreMessage): string {
  switch(m.role) {
    case "user":
      return `User: ${m.content}`;
    case "assistant":
      return `Assistant: ${formatParts(m.content)}`;
    case "tool":
      return `Tool: ${formatParts(m.content)}`;

    default:
      return `${m.role}: ${m.content}`;
  }
}

function formatParts(part: AssistantContent | ToolContent): string {
  if (typeof part === "string") {
    return part;
  }

  if (Array.isArray(part)) {
    if (part.length === 1) {
      return formatPart(part[0]);
    }

    return `\n${part.map(formatPart).join("\n")}`;
  }

  return "Unknown content: " + JSON.stringify(part);
}

function formatPart(part: (Exclude<AssistantContent, string> | ToolContent)[number]): string {
  switch(part.type) {
    case "text":
      return part.text;
    case "file":
      return `(file): ${part.filename} ${typeof part.data === "string" ? `url:${part.data}` : 'base64:omitted'}`;
    case "tool-call":
      return `(tool call): ${part.toolName} id:${part.toolCallId} args:(${JSON.stringify(part.args)})`;
    case "tool-result":
      return `(tool result): ${part.toolName} id:${part.toolCallId} result:(${JSON.stringify(part.result)})`;
    case "reasoning":
      return `(reasoning): ${part.text}`;
    case "redacted-reasoning":
      return `(redacted reasoning): ${part.data}`;
    default:
      return `Unknown content: ${JSON.stringify(part)}`;
  }
}
