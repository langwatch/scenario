import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import pluginReact from "eslint-plugin-react";
import * as mdx from "eslint-plugin-mdx";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    ignores: ["**/dist/**/*"],
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: { globals: globals.browser },
  },
  tseslint.configs.recommended,
  pluginReact.configs.flat.recommended,
  {
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
      "react/react-in-jsx-scope": "off", // Not needed with new JSX transform
    },
  },
  {
    files: ["**/*.mdx"],
    ...mdx.flat,
    processor: mdx.createRemarkProcessor(),
    rules: {
      ...mdx.flat.rules,
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
]);
