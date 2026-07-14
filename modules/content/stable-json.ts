/**
 * Deterministic JSON serialization: object keys are emitted in sorted
 * order (arrays keep their meaningful order), so identical input always
 * produces byte-identical output. Browser-safe.
 */

export function stableStringify(value: unknown): string {
  return emit(value, "");
}

function emit(value: unknown, indent: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(
        `stableStringify: unsupported value of type ${typeof value}`,
      );
  }

  const childIndent = indent + " ";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map(
      (item) => `${childIndent}${emit(item, childIndent)}`,
    );
    return `[\n${items.join(",\n")}\n${indent}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return "{}";
  const props = entries.map(
    ([key, v]) =>
      `${childIndent}${JSON.stringify(key)}: ${emit(v, childIndent)}`,
  );
  return `{\n${props.join(",\n")}\n${indent}}`;
}

/** Serialize an artifact: deterministic body plus a single trailing newline. */
export function serializeArtifact(value: unknown): string {
  return `${stableStringify(value)}\n`;
}
