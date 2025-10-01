#!/usr/bin/env node

/**
 * Generate MDX files from test examples for documentation
 *
 * This script reads test files and generates MDX code blocks that can be
 * imported in the documentation. This ensures docs always show current code.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const workspaceRoot = path.resolve(__dirname, "..", "..");
const outputDir = path.resolve(
  __dirname,
  "..",
  "docs",
  "pages",
  "_generated",
  "examples"
);

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

/**
 * Get language from file extension
 */
function getLanguageFromExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const languageMap = {
    ".ts": "typescript",
    ".js": "javascript",
    ".py": "python",
    ".tsx": "typescript",
    ".jsx": "javascript",
    ".java": "java",
    ".go": "go",
    ".rs": "rust",
    ".cpp": "cpp",
    ".c": "c",
    ".cs": "csharp",
    ".php": "php",
    ".rb": "ruby",
    ".swift": "swift",
    ".kt": "kotlin",
    ".scala": "scala",
    ".sh": "bash",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".json": "json",
    ".xml": "xml",
    ".html": "html",
    ".css": "css",
    ".scss": "scss",
    ".sass": "sass",
    ".md": "markdown",
    ".sql": "sql",
  };
  return languageMap[ext] || "text";
}

/**
 * Get name from file path (filename without extension)
 */
function getNameFromPath(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

/**
 * Configuration for which examples to generate
 */
const examples = [
  {
    sourcePath:
      "javascript/examples/vitest/tests/multimodal-voice-to-voice-conversation.test.ts",
  },
  {
    sourcePath:
      "javascript/examples/vitest/tests/multimodal-audio-to-text.test.ts",
  },
  {
    sourcePath:
      "javascript/examples/vitest/tests/multimodal-audio-to-audio.test.ts",
  },
];

/**
 * Generate an MDX snippet file containing just a code block
 * These can be imported/transcluded into other MDX files
 */
function generateExample(example) {
  const sourceFile = path.join(workspaceRoot, example.sourcePath);

  if (!fs.existsSync(sourceFile)) {
    console.warn(`⚠️  Source file not found: ${example.sourcePath}`);
    return;
  }

  const code = fs.readFileSync(sourceFile, "utf-8");
  const githubUrl = `https://github.com/langwatch/scenario/blob/main/${example.sourcePath}`;

  // Get name from file path and language from extension
  const name = getNameFromPath(example.sourcePath);
  const language = getLanguageFromExtension(example.sourcePath);

  // Use label if provided, otherwise use name
  const displayLabel = example.label || name;

  // Generate simple code fence without additional MDX processing
  // This will be rendered as-is when imported
  const mdxContent = `\`\`\`${language} [${displayLabel}]
// Source: ${githubUrl}
${code}
\`\`\`
`;

  const outputFile = path.join(outputDir, `${name}.mdx`);
  fs.writeFileSync(outputFile, mdxContent);

  console.log(`✓ Generated: ${name}.mdx`);
}

/**
 * Generate .gitignore to ignore generated files
 */
function generateGitignore() {
  const gitignorePath = path.join(path.dirname(outputDir), ".gitignore");
  const gitignoreContent = `# Auto-generated examples - do not commit
examples/
`;

  fs.writeFileSync(gitignorePath, gitignoreContent);
  console.log("✓ Generated: _generated/.gitignore");
}

// Main execution
console.log("🔨 Generating documentation examples...\n");

examples.forEach(generateExample);
generateGitignore();

console.log("\n✅ Done! Generated", examples.length, "examples");
