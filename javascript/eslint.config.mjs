import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import importPlugin from "eslint-plugin-import";
import unusedImports from "eslint-plugin-unused-imports";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  importPlugin.flatConfigs.recommended,
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/api-reference-docs/**",
      "**/docs/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs,ts}"],
    plugins: { js, "unused-imports": unusedImports },
    extends: ["js/recommended"],
    rules: {
      "no-unused-vars": "off", // or "@typescript-eslint/no-unused-vars": "off",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],
      "import/order": [
        "error",
        {
          groups: ["builtin", "external", "internal"],
          alphabetize: {
            order: "asc",
            caseInsensitive: true,
          },
        },
      ],
    },
    settings: {
      "import/resolver": {
        // You will also need to install and configure the TypeScript resolver
        // See also https://github.com/import-js/eslint-import-resolver-typescript#configuration
        typescript: true,
        node: true,
      },
    },
  },
  {
    files: ["**/*.{js,mjs,cjs,ts}"],
    languageOptions: { globals: globals.browser },
  },
  {
    // Build tooling and the maintenance scripts run under Node, not a browser.
    // Without this, `scripts/**` is linted with browser globals and reports
    // no-undef on Buffer/process (#565).
    files: [
      "**/*.config.{js,mjs,cjs,ts}",
      "eslint.config.mjs",
      "scripts/**/*.{js,mjs,cjs,ts}",
    ],
    languageOptions: { globals: globals.node },
  },
  tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // Forbid non-null assertions (`!`) in shipped library source. Tests and
    // examples legitimately assert known-present fixtures, so the rule is
    // scoped to non-test `src/` only.
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts", "src/**/__tests__/**"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
  {
    // `no-explicit-any` stays an ERROR on the shipped library (currently 0) and
    // drops to a warning in tests. Test suites reach private members through
    // `(agent as any).internalField` to drive state directly; typing those away
    // would mean widening the production API or mirroring its privates, so the
    // `any` is the lesser evil. See #565 and dec.2026-08-01-scenario-565-lint-ac-set.
    files: ["src/**/*.test.ts", "src/**/__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
]);
