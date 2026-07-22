/**
 * Better Auth core tables (Phase 15). Generated as the authoritative
 * starting point via the Better Auth CLI:
 *
 *   npx auth generate --adapter drizzle --dialect postgresql \
 *     --config <config exporting betterAuth({ ... modelName: "users"/"sessions"/
 *       "accounts"/"verifications", rateLimit: { modelName: "rate_limits" },
 *       advanced: { database: { generateId: "uuid" } } })>
 *
 * then hand-integrated here with three additions the CLI does not emit: the
 * `role` CHECK constraint (CLAUDE.md/DATA_MODEL.md — role is server-owned,
 * never client-settable), the plural table names DATA_MODEL.md/§16 requires
 * (`users`/`sessions`/`accounts`/`verifications`/`rate_limits`), configured
 * explicitly via `modelName` rather than relying on `usePlural`, and a
 * case-insensitive unique index on lower(email) replacing the CLI's plain
 * `.unique()` (§16 requires effective case-insensitive email uniqueness).
 * Column names/types are otherwise exactly what the CLI generated — do not
 * hand-tune them without re-running generation to confirm drift.
 */
import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const ALLOWED_ROLES = ["learner", "admin"] as const;
export type UserRole = (typeof ALLOWED_ROLES)[number];

export const users = pgTable(
  "users",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    role: text("role").notNull().default("learner"),
  },
  (table) => [
    check("users_role_check", sql`${table.role} IN ('learner', 'admin')`),
    // Case-insensitive uniqueness (phases-15.md §16): a plain UNIQUE on
    // `email` only rejects byte-identical duplicates — "User@x.com" and
    // "user@x.com" would otherwise both insert. Indexing lower(email)
    // instead of the raw column is what actually enforces "differing
    // casing cannot create two accounts".
    uniqueIndex("users_email_lower_unique_idx").on(sql`lower(${table.email})`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("accounts_user_id_idx").on(table.userId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)],
);

/** Database-backed rate limiting (Better Auth `rateLimit.storage: "database"`) — required because in-memory rate limiting is not reliable across serverless instances. */
export const rateLimits = pgTable("rate_limits", {
  id: uuid("id")
    .default(sql`pg_catalog.gen_random_uuid()`)
    .primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  accounts: many(accounts),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));
