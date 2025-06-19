import { generate } from "xksuid";

export function generateThreadId(): string {
  return `thread_${generate()}`;
}
