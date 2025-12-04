/**
 * Recursively transforms values in a structure.
 * If callback returns a different value, uses it and stops recursion for that branch.
 * Otherwise recurses into arrays/objects.
 */
export function deepTransform(
  value: unknown,
  fn: (v: unknown) => unknown
): unknown {
  const result = fn(value);
  if (result !== value) return result;

  if (Array.isArray(value)) {
    return value.map((v) => deepTransform(v, fn));
  }

  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepTransform(v, fn);
    }
    return out;
  }

  return value;
}

