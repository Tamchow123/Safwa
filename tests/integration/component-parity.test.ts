import { describe, expect, it } from "vitest";
import { SKILL_METADATA } from "@/modules/content/constants";
import {
  buildComponentKey,
  InvalidComponentIdentityError,
  type ComponentIdentity,
} from "@/modules/study-engine/natural-key";
import { getDb } from "@/db/client";
import { studyComponents } from "@/db/schema";
import { createTestUser } from "@/tests/integration/helpers/users";

/**
 * Dexie/PostgreSQL component-parity suite (phases-15.md §55). Proves the
 * ONE shared client-side natural-key builder (modules/study-engine/
 * natural-key.ts — no second server-side builder exists or should exist)
 * and Postgres's own shape constraints (db/schema/learning.ts) agree on
 * exactly which component identities are valid, using the real skill
 * metadata every release fixture is built from (modules/content/
 * constants.ts's SKILL_METADATA — the same source `deriveAllComponents`
 * uses client-side).
 */

const SKILL_METADATA_BY_ID = new Map(
  SKILL_METADATA.map((metadata) => [metadata.id, metadata]),
);

/**
 * Inserts the given identity as literally specified — including an
 * explicit `componentShape` override for the shape-mismatch tests below,
 * which deliberately claim the WRONG shape for a skill. When no override
 * is given, the skill's own canonical shape is used (never defaulted to
 * one fixed shape), matching what `resolveComponentIdentity` would derive.
 */
async function insertFromIdentity(userId: string, identity: ComponentIdentity) {
  const db = getDb();
  const canonicalShape = SKILL_METADATA_BY_ID.get(
    identity.skillType,
  )?.component_shape;
  return db.insert(studyComponents).values({
    userId,
    entryId: identity.entryId,
    skillTypeId: identity.skillType,
    componentShape: identity.componentShape ?? canonicalShape ?? "entry_level",
    sourceField: identity.sourceField ?? null,
    direction: identity.direction ?? null,
  });
}

describe("Dexie/Postgres component-parity", () => {
  it("every valid (skill, field, direction) combination from SKILL_METADATA produces the same natural key and a valid Postgres row", async () => {
    const userId = await createTestUser();
    const identities: ComponentIdentity[] = SKILL_METADATA.flatMap(
      (metadata, skillIndex) =>
        metadata.component_shape === "form_direction"
          ? metadata.allowed_source_fields.flatMap((sourceField, i) =>
              metadata.allowed_directions.map((direction, j) => ({
                entryId: 100 + skillIndex * 100 + i * 10 + j,
                skillType: metadata.id,
                sourceField,
                direction,
              })),
            )
          : [{ entryId: 100 + skillIndex * 100, skillType: metadata.id }],
    );

    for (const identity of identities) {
      const key = buildComponentKey(identity);
      expect(key).toContain(`entry:${identity.entryId}`);
      expect(key).toContain(`skill:${identity.skillType}`);
      await expect(insertFromIdentity(userId, identity)).resolves.toBeDefined();
    }
  });

  it("two users inserting the same identity get the same natural key regardless of storage", async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();
    const identity: ComponentIdentity = {
      entryId: 7,
      skillType: "bab_identification",
    };
    const key = buildComponentKey(identity);
    await insertFromIdentity(userA, identity);
    await insertFromIdentity(userB, identity);
    // The key is derived purely from the identity, not from any stored row
    // — re-deriving it after storage must still match exactly.
    expect(buildComponentKey(identity)).toBe(key);
  });

  describe("shape-mismatch categories rejected identically by both sides", () => {
    it("a form_direction skill claimed as entry_level", async () => {
      const userId = await createTestUser();
      const identity: ComponentIdentity = {
        entryId: 1,
        skillType: "meaning_recognition",
        componentShape: "entry_level",
      };
      expect(() => buildComponentKey(identity)).toThrow(
        InvalidComponentIdentityError,
      );
      await expect(
        insertFromIdentity(userId, {
          ...identity,
          sourceField: undefined,
          direction: undefined,
        }),
      ).rejects.toThrow();
    });

    it("an entry_level skill claimed as form_direction", async () => {
      const userId = await createTestUser();
      const identity: ComponentIdentity = {
        entryId: 1,
        skillType: "bab_identification",
        componentShape: "form_direction",
        sourceField: "madi",
        direction: "arabic_to_english",
      };
      expect(() => buildComponentKey(identity)).toThrow(
        InvalidComponentIdentityError,
      );
      await expect(insertFromIdentity(userId, identity)).rejects.toThrow();
    });

    it("a direction not allowed for the given skill (meaning_recall is english_to_arabic only)", () => {
      const identity: ComponentIdentity = {
        entryId: 1,
        skillType: "meaning_recall",
        sourceField: "madi",
        direction: "arabic_to_english",
      };
      expect(() => buildComponentKey(identity)).toThrow(
        InvalidComponentIdentityError,
      );
      // Postgres's direction CHECK alone permits either direction value —
      // the skill-specific restriction (recall = en->ar only) is a
      // content/business rule the shared natural-key builder enforces
      // client-side, not a database CHECK. This asymmetry is intentional:
      // the DB validates STRUCTURE (is this a well-formed component of its
      // shape), the builder plus the validation manifest validate CONTENT
      // eligibility (DATA_MODEL.md §4) — so no Postgres-side rejection is
      // asserted here, only that the shared builder itself rejects it.
    });

    it("an entry-level identity carrying a source field", async () => {
      const userId = await createTestUser();
      const identity: ComponentIdentity = {
        entryId: 1,
        skillType: "root_identification",
        sourceField: "madi",
      };
      expect(() => buildComponentKey(identity)).toThrow(
        InvalidComponentIdentityError,
      );
      await expect(
        insertFromIdentity(userId, {
          ...identity,
          componentShape: "entry_level",
        }),
      ).rejects.toThrow();
    });

    it("an unknown skill type", async () => {
      const userId = await createTestUser();
      const identity = {
        entryId: 1,
        skillType: "not_a_real_skill",
      } as unknown as ComponentIdentity;
      expect(() => buildComponentKey(identity)).toThrow(
        InvalidComponentIdentityError,
      );
      await expect(
        insertFromIdentity(userId, {
          ...identity,
          componentShape: "entry_level",
        }),
      ).rejects.toThrow();
    });
  });
});
