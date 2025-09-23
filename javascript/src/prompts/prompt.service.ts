import prompts from "./generated.json";
import { Prompt } from "./prompt";
import { type PromptData } from "./types";

type PromptDictionary = typeof prompts;

export class PromptService {
  constructor(private prompts: PromptDictionary) {}

  get(handle: keyof PromptDictionary) {
    const prompt = this.prompts[handle];
    if (!prompt) {
      throw new Error(`Prompt ${handle} not found`);
    }
    return new Prompt(prompt as PromptData);
  }
}

export const promptService = new PromptService(prompts);
