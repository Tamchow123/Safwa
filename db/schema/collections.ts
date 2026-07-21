/**
 * Account-linked bookmark/list tables (Phase 15). Future sync target only —
 * Phase 14 shipped the guest-local Dexie equivalent with no server
 * component; no sync exists yet (DATA_MODEL.md §7). Never stores Arabic,
 * meanings or eligibility — entry_id is the sole join key.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "@/db/schema/auth";

/** Matches Phase 14's client-side bound (modules/collections/validation.ts). */
export const CUSTOM_LIST_NAME_MAX_LENGTH = 60;

export const bookmarks = pgTable(
  "bookmarks",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    entryId: integer("entry_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("bookmarks_user_entry_unique").on(table.userId, table.entryId),
  ],
);

export const customLists = pgTable(
  "custom_lists",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalisedName: text("normalised_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    unique("custom_lists_user_normalised_name_unique").on(
      table.userId,
      table.normalisedName,
    ),
    check(
      "custom_lists_name_length_check",
      sql`char_length(${table.name}) BETWEEN 1 AND ${CUSTOM_LIST_NAME_MAX_LENGTH}`,
    ),
    check(
      "custom_lists_updated_not_before_created_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
    index("custom_lists_user_idx").on(table.userId),
  ],
);

export const customListEntries = pgTable(
  "custom_list_entries",
  {
    listId: uuid("list_id")
      .notNull()
      .references(() => customLists.id, { onDelete: "cascade" }),
    entryId: integer("entry_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("custom_list_entries_list_entry_unique").on(
      table.listId,
      table.entryId,
    ),
    index("custom_list_entries_entry_idx").on(table.entryId),
  ],
);
