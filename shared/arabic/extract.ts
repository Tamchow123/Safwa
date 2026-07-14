/**
 * Codepoint-safe Arabic evidence helpers — the TypeScript twin of
 * scripts/arabic-extract.py. Arabic values must never be trusted from
 * rendered terminal output or typed by hand (CLAUDE.md); these helpers
 * produce ASCII-safe representations for tests, logs and verification.
 *
 * Pure and browser-safe: no filesystem access — callers supply the values.
 */

/** `U+XXXX` codepoint list, e.g. "U+0637 U+064E ...". */
export function toCodepointList(value: string): string {
  return [...value]
    .map(
      (ch) =>
        `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
    )
    .join(" ");
}

/** `\uXXXX` escape representation (pure ASCII). */
export function toEscaped(value: string): string {
  return [...value]
    .map((ch) => {
      const code = ch.codePointAt(0)!;
      if (code > 0xffff) {
        // Encode as a surrogate pair for exact JS-string equivalence.
        return [...ch]
          .flatMap((c) =>
            Array.from({ length: c.length }, (_, i) => c.charCodeAt(i)),
          )
          .map((unit) => `\\u${unit.toString(16).padStart(4, "0")}`)
          .join("");
      }
      return `\\u${code.toString(16).padStart(4, "0")}`;
    })
    .join("");
}

export function isNfc(value: string): boolean {
  return value === value.normalize("NFC");
}

export type ComparisonEvidence = {
  equal: boolean;
  aEscaped: string;
  bEscaped: string;
  aCodepointCount: number;
  bCodepointCount: number;
};

/** ASCII-safe evidence for an exact-value comparison (no rendered Arabic). */
export function comparisonEvidence(a: string, b: string): ComparisonEvidence {
  return {
    equal: a === b,
    aEscaped: toEscaped(a),
    bEscaped: toEscaped(b),
    aCodepointCount: [...a].length,
    bCodepointCount: [...b].length,
  };
}
