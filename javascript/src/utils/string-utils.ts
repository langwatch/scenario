/**
 * String utility functions.
 */

/**
 * Converts a string to kebab-case.
 *
 * @param str - The string to convert.
 * @returns The kebab-case string.
 *
 * @example
 * ```typescript
 * StringUtils.kebabCase("Hello World") // "hello-world"
 * StringUtils.kebabCase("camelCase") // "camel-case"
 * ```
 */
export function kebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

export const StringUtils = {
  kebabCase,
};
