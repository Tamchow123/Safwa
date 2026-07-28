/**
 * The E2E raw-IndexedDB helpers cannot import the Dexie schema — their bodies
 * run inside `page.evaluate` in the browser — so they carry their own map from
 * the logical store names the specs use to the PHYSICAL names schema v7 created
 * (`bookmarks` → `bookmarks_owned`, …). A hand-maintained second copy of the
 * schema owner's names can drift, and a drifted name would make an E2E read hit
 * a store that does not exist. This test is the tie-back: the two maps must
 * agree, so a future rename fails here rather than silently in a spec.
 */
import { describe, expect, it } from "vitest";

import { OWNED_STORE_NAMES } from "@/modules/content/db";
import { PHYSICAL_STORE_NAMES } from "@/e2e/helpers/idb";

describe("E2E physical store names track the Dexie schema", () => {
  it("maps every owner-keyed store to the name the schema owner declares", () => {
    expect(PHYSICAL_STORE_NAMES).toEqual({
      study_components: OWNED_STORE_NAMES.studyComponents,
      bookmarks: OWNED_STORE_NAMES.bookmarks,
      settings: OWNED_STORE_NAMES.settings,
      daily_activity: OWNED_STORE_NAMES.dailyActivity,
    });
  });

  it("covers every store the schema owner re-keyed (no silent omission)", () => {
    // A future owner-keyed store added to OWNED_STORE_NAMES must also be
    // mapped here, or specs seeding it would write to the dropped v6 store.
    expect(Object.values(PHYSICAL_STORE_NAMES).sort()).toEqual(
      Object.values(OWNED_STORE_NAMES).sort(),
    );
  });
});
