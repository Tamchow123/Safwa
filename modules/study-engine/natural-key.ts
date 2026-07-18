/**
 * The shared study-component natural-key builder (DATA_MODEL.md §2).
 *
 * This is THE single builder used by the client now and the server in
 * Phase 16 — component identity must be byte-identical on both sides. The
 * builder rejects any skill/shape/field/direction mismatch, so an invalid
 * component identity can never be represented as a key.
 *
 * Key formats:
 *   form:        entry:{entryId}:skill:{skillId}:field:{field}:direction:{direction}
 *   entry-level: entry:{entryId}:skill:{skillId}
 *
 * Pure TypeScript: no React, DOM or DB imports (see docs/ARCHITECTURE.md §2).
 */
import {
  COMPONENT_SHAPES,
  DIRECTIONS,
  SKILL_METADATA,
  SKILL_TYPES,
  SOURCE_QUIZ_FORM_FIELDS,
  type ComponentShape,
  type Direction,
  type SkillType,
  type SourceQuizFormField,
} from "@/modules/content/constants";

/** Logical identity of a study component (before serialisation to a key). */
export type ComponentIdentity = {
  entryId: number;
  skillType: SkillType;
  /**
   * Optional at the typed boundary; when supplied (e.g. rehydrating a stored
   * record) it is strictly validated to match the skill's canonical shape —
   * a mismatch (root skill claimed as form_direction, etc.) is rejected.
   */
  componentShape?: ComponentShape | null;
  /** Required for form_direction skills; must be absent for entry_level. */
  sourceField?: SourceQuizFormField | null;
  /** Required for form_direction skills; must be absent for entry_level. */
  direction?: Direction | null;
};

/** A fully-resolved component identity, guaranteed shape-consistent. */
export type ResolvedComponentIdentity = {
  entryId: number;
  skillType: SkillType;
  componentShape: ComponentShape;
  sourceField: SourceQuizFormField | null;
  direction: Direction | null;
};

const SKILL_METADATA_BY_ID = new Map(
  SKILL_METADATA.map((metadata) => [metadata.id, metadata]),
);

export class InvalidComponentIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidComponentIdentityError";
  }
}

function fail(message: string): never {
  throw new InvalidComponentIdentityError(message);
}

/**
 * Validate a loose identity into a shape-consistent resolved identity, or
 * throw. Rejects: unknown skills, non-positive/non-integer ids, a
 * form_direction skill missing (or with a disallowed) field/direction, and an
 * entry_level skill carrying a field/direction.
 */
export function resolveComponentIdentity(
  identity: ComponentIdentity,
): ResolvedComponentIdentity {
  const { entryId, skillType } = identity;
  // Safe integer (not just integer): a huge integer like 1e21 stringifies to
  // scientific notation, which the key format / parser cannot round-trip.
  if (!Number.isSafeInteger(entryId) || entryId < 1) {
    fail(
      `entryId must be a positive safe integer, received ${String(entryId)}`,
    );
  }
  const metadata = SKILL_METADATA_BY_ID.get(skillType);
  if (!metadata) {
    fail(`unknown skill type ${JSON.stringify(skillType)}`);
  }

  // If a shape was supplied at the boundary it must match the skill's
  // canonical shape — the builder rejects skill/shape mismatches (the same
  // invariant the DB enforces via the composite FK, DATA_MODEL.md §4).
  if (
    identity.componentShape != null &&
    identity.componentShape !== metadata.component_shape
  ) {
    fail(
      `skill ${skillType} has shape ${metadata.component_shape}, not ${identity.componentShape}`,
    );
  }

  const sourceField = identity.sourceField ?? null;
  const direction = identity.direction ?? null;

  if (metadata.component_shape === "form_direction") {
    if (sourceField === null) {
      fail(`skill ${skillType} (form_direction) requires a source field`);
    }
    if (direction === null) {
      fail(`skill ${skillType} (form_direction) requires a direction`);
    }
    if (!metadata.allowed_source_fields.includes(sourceField)) {
      fail(
        `source field ${JSON.stringify(sourceField)} is not allowed for skill ${skillType}`,
      );
    }
    if (!metadata.allowed_directions.includes(direction)) {
      fail(
        `direction ${JSON.stringify(direction)} is not allowed for skill ${skillType}`,
      );
    }
    return {
      entryId,
      skillType,
      componentShape: "form_direction",
      sourceField,
      direction,
    };
  }

  // entry_level
  if (sourceField !== null) {
    fail(`skill ${skillType} (entry_level) must not carry a source field`);
  }
  if (direction !== null) {
    fail(`skill ${skillType} (entry_level) must not carry a direction`);
  }
  return {
    entryId,
    skillType,
    componentShape: "entry_level",
    sourceField: null,
    direction: null,
  };
}

/** Build the shared natural-key string for a component identity. Throws on any
 * invalid combination. */
export function buildComponentKey(identity: ComponentIdentity): string {
  const resolved = resolveComponentIdentity(identity);
  if (resolved.componentShape === "form_direction") {
    return (
      `entry:${resolved.entryId}` +
      `:skill:${resolved.skillType}` +
      `:field:${resolved.sourceField}` +
      `:direction:${resolved.direction}`
    );
  }
  return `entry:${resolved.entryId}:skill:${resolved.skillType}`;
}

const FORM_KEY_PATTERN =
  /^entry:([1-9][0-9]*):skill:([a-z_]+):field:([a-z_]+):direction:([a-z_]+)$/;
const ENTRY_LEVEL_KEY_PATTERN = /^entry:([1-9][0-9]*):skill:([a-z_]+)$/;

function asSkillType(value: string): SkillType {
  if (!(SKILL_TYPES as readonly string[]).includes(value)) {
    fail(`unknown skill type ${JSON.stringify(value)}`);
  }
  return value as SkillType;
}

function asSourceField(value: string): SourceQuizFormField {
  if (!(SOURCE_QUIZ_FORM_FIELDS as readonly string[]).includes(value)) {
    fail(`unknown source field ${JSON.stringify(value)}`);
  }
  return value as SourceQuizFormField;
}

function asDirection(value: string): Direction {
  if (!(DIRECTIONS as readonly string[]).includes(value)) {
    fail(`unknown direction ${JSON.stringify(value)}`);
  }
  return value as Direction;
}

/**
 * Parse a natural-key string back to a resolved identity, re-validating shape
 * against the skill metadata. Any structurally or semantically invalid key
 * throws — the parse and the builder agree exactly (round-trip safe).
 */
export function parseComponentKey(key: string): ResolvedComponentIdentity {
  const formMatch = FORM_KEY_PATTERN.exec(key);
  if (formMatch) {
    return resolveComponentIdentity({
      entryId: Number(formMatch[1]),
      skillType: asSkillType(formMatch[2]),
      sourceField: asSourceField(formMatch[3]),
      direction: asDirection(formMatch[4]),
    });
  }
  const entryMatch = ENTRY_LEVEL_KEY_PATTERN.exec(key);
  if (entryMatch) {
    return resolveComponentIdentity({
      entryId: Number(entryMatch[1]),
      skillType: asSkillType(entryMatch[2]),
    });
  }
  fail(`malformed component key ${JSON.stringify(key)}`);
}

/** Structural check: is this a syntactically valid, shape-consistent key? */
export function isValidComponentKey(key: string): boolean {
  try {
    parseComponentKey(key);
    return true;
  } catch {
    return false;
  }
}

/** Enumerate the two component shapes (helper for exhaustive tests/tools). */
export const COMPONENT_SHAPE_VALUES: readonly ComponentShape[] =
  COMPONENT_SHAPES;
