import { CoreMessage } from "ai";
import { ScenarioExecutionStateLike, ScriptStep } from "../domain";

export const message = (message: CoreMessage): ScriptStep => {
  return (_state, executor) => executor.message(message);
}

export const agent = (content?: string | CoreMessage): ScriptStep => {
  return (_state, executor) => executor.agent(content);
}

export const judge = (content?: string | CoreMessage): ScriptStep => {
  return (_state, executor) => executor.judge(content);
}

export const user = (content?: string | CoreMessage): ScriptStep => {
  return (_state, executor) => executor.user(content);
}

export const proceed = (
  turns?: number,
  onTurn?: (state: ScenarioExecutionStateLike) => void | Promise<void>,
  onStep?: (state: ScenarioExecutionStateLike) => void | Promise<void>,
): ScriptStep => {
  return (_state, executor) => executor.proceed(turns, onTurn, onStep);
}

export const succeed = (reasoning?: string): ScriptStep => {
  return (_state, executor) => executor.succeed(reasoning);
}

export const fail = (reasoning?: string): ScriptStep => {
  return (_state, executor) => executor.fail(reasoning);
}
