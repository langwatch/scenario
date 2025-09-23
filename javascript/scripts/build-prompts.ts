import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { parse } from "yaml";

const promptsDir = join(process.cwd(), "../prompts");
const outputFile = join(process.cwd(), "../prompts", "generated.json");

// Read all .prompt.yaml files
const promptFiles = readdirSync(promptsDir).filter((f) =>
  f.endsWith(".prompt.yaml")
);

const prompts: Record<string, string> = {};
promptFiles.forEach((file) => {
  const promptId = file.replace(".prompt.yaml", "");
  const content = readFileSync(join(promptsDir, file), "utf-8");
  const parsed = parse(content);
  prompts[promptId] = parsed;
});

// Write the JSON file
const jsonContent = JSON.stringify(prompts, null, 2);
writeFileSync(outputFile, jsonContent);

console.log("✅ Prompts built");
console.log(`📁 Generated: ${Object.keys(prompts).length} prompts`);
