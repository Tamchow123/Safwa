/**
 * Phase 17 §18 — settings semantics that are SPECIFIC TO A MERGE.
 *
 * The rule is "account settings win; guest settings may fill only genuine
 * account gaps", and §18 requires the gap to be DEFINED rather than assumed,
 * because the schema might make it undefinable. It nearly does. Every syncable
 * column on `user_settings` is NOT NULL with a default (`theme` defaults to
 * `'system'`, `question_count` to 20, and so on), so once a row exists there is
 * no value that means "unset". A row saying `theme = 'system'` is
 * indistinguishable from a row where the learner deliberately chose `system`.
 *
 * So the gap is at the ROW, not the field:
 *
 *   GAP      — the account has no `user_settings` row at all. Nothing has ever
 *              written a preference for this account: `getAccountSettings`
 *              treats the absent row as "the documented defaults", and the row
 *              is created lazily, only by `upsertAccountSettings` /
 *              `resetAccountSettings` / a settings sync — never at signup. An
 *              absent row is therefore real evidence of silence, and valid
 *              guest settings may speak into it.
 *   NO GAP   — a row exists. Every syncable value in it is an account value,
 *              and every one of them wins. Guest values are reported as kept
 *              from the account and nothing is written.
 *
 * The alternative — per-field provenance columns recording whether each setting
 * was ever explicitly chosen — is exactly what §18 says not to add ("do not
 * introduce field-level provenance unless it is genuinely required for
 * correctness"). It is not required: the row-level rule never overwrites an
 * account preference, which is the property that actually matters. Its only
 * cost is that a learner who changed one setting while signed in keeps the
 * defaults for the others rather than adopting the guest's — a conservative
 * failure, and the direction §18 chooses ("account settings win").
 *
 * `server-only`.
 */
import "server-only";

import { eq, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { userSettings } from "@/db/schema";
import { type SyncItemResult, type WireSetting } from "@/modules/sync/protocol";

import { writeSyncAudit } from "./audit";
import { nextAccountCursor } from "./cursor";
import { type SettingApplication, validateSetting } from "./settings";

export type GuestMergeSettingsOptions = {
  correlationId?: string;
};

export type GuestSettingsMergeResult = {
  results: SyncItemResult[];
  /** Guest values written into a genuinely empty account (§18). */
  adopted: number;
  /** Guest values the account's own value outranked. */
  keptFromAccount: number;
  /** Guest values the server allow-list or value validator refused. */
  rejected: number;
  serverCursor: number;
};

function result(
  key: string,
  status: SyncItemResult["status"],
  reasonCode: SyncItemResult["reasonCode"],
): SyncItemResult {
  return {
    itemId: key,
    itemKind: "setting",
    status,
    reasonCode,
    duplicate: status === "duplicate",
    recoverable: false,
  };
}

/**
 * Merge guest settings into the account under the account-wins rule above.
 *
 * LOCKING — this is the one place in the codebase that has to exclude BOTH
 * writers of `user_settings`, because it is the only one whose decision depends
 * on the row not existing yet. The two writers do not share a key:
 *
 *   `modules/auth/account-settings.ts` (the profile page)  -> hashtext(userId)
 *   `modules/sync/server/settings.ts`  (ordinary sync)     -> hashtext(`${userId}:settings`)
 *
 * Holding only one of them would leave "is there a row?" and "insert one"
 * splittable by the other, and the insert's `ON CONFLICT DO NOTHING` would then
 * quietly write nothing while this function still reported the guest values as
 * adopted. So both are taken, always in this order. No other transaction takes
 * both, so a fixed order here cannot participate in a lock cycle.
 *
 * The counts are ALSO derived from what the insert actually wrote rather than
 * from what was intended, so even if a future writer appeared on a third key,
 * this function would report a lost race honestly instead of claiming a merge
 * that did not happen.
 */
export async function mergeGuestSettings(
  userId: string,
  settings: readonly WireSetting[],
  options: GuestMergeSettingsOptions = {},
): Promise<GuestSettingsMergeResult> {
  const db = getDb();
  if (settings.length === 0) {
    return {
      results: [],
      adopted: 0,
      keptFromAccount: 0,
      rejected: 0,
      serverCursor: 0,
    };
  }

  // Deterministic within-batch resolution, matching the ordinary path: for a
  // repeated key the latest client `updatedAt` is the one considered.
  const latestByKey = new Map<string, WireSetting>();
  for (const setting of settings) {
    const previous = latestByKey.get(setting.key);
    if (!previous || setting.updatedAt >= previous.updatedAt) {
      latestByKey.set(setting.key, setting);
    }
  }

  return db.transaction(async (tx) => {
    // Both writers of `user_settings`, in a fixed order — see the note above.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}), 0)`);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${userId}:settings`}), 0)`,
    );

    const [existingRow] = await tx
      .select({ userId: userSettings.userId })
      .from(userSettings)
      .where(eq(userSettings.userId, userId));
    const accountHasSettings = existingRow !== undefined;

    const results: SyncItemResult[] = [];
    let adopted = 0;
    let keptFromAccount = 0;
    let rejected = 0;
    const columns: SettingApplication = {};
    const invalidKeys: string[] = [];

    for (const setting of settings) {
      if (latestByKey.get(setting.key) !== setting) {
        results.push(result(setting.key, "duplicate", "duplicate"));
        continue;
      }
      // Validated through the SERVER's allow-list and value bounds, whether or
      // not it will be applied — a key outside SYNCABLE_SETTING_KEYS or a value
      // outside its bounds is reported as rejected rather than quietly counted
      // as "kept from the account", which would hide a tampered payload behind
      // an outcome that looks normal (§30).
      const application = validateSetting(setting.key, setting.value);
      if (!application) {
        invalidKeys.push(setting.key);
        rejected += 1;
        results.push(result(setting.key, "rejected", "invalid_setting_key"));
        continue;
      }
      if (accountHasSettings) {
        keptFromAccount += 1;
        results.push(result(setting.key, "duplicate", "duplicate"));
        continue;
      }
      Object.assign(columns, application);
      adopted += 1;
      results.push(result(setting.key, "accepted", "accepted"));
    }

    for (const key of invalidKeys) {
      await writeSyncAudit(tx, {
        userId,
        itemKind: "setting",
        itemId: key,
        reasonCode: "invalid_setting_key",
        severity: "warning",
        correlationId: options.correlationId,
      });
    }

    if (adopted === 0) {
      // Nothing to write: no cursor bump, so a repeated merge does not wake
      // another device for a change that is not there (§18).
      return { results, adopted, keptFromAccount, rejected, serverCursor: 0 };
    }

    const cursor = await nextAccountCursor(tx, userId);
    const written = await tx
      .insert(userSettings)
      .values({ userId, ...columns, lastSyncSeq: cursor })
      // Both writers are locked out above, so this conflict clause should never
      // fire. `DO NOTHING` rather than `DO UPDATE` is what makes losing that bet
      // harmless: if a row appeared anyway, it is an ACCOUNT row, and an account
      // value must never be overwritten by a guest one (§18).
      .onConflictDoNothing({ target: userSettings.userId })
      .returning({ userId: userSettings.userId });

    if (written.length === 0) {
      // The bet was lost: a row exists that this transaction did not write, so
      // nothing was adopted after all. Report what HAPPENED, not what was
      // planned — a caller told "2 settings adopted" when none were persisted
      // would go on to delete the guest's local copy of them.
      //
      // The cursor was already taken. It is left advanced rather than rolled
      // back: `nextAccountCursor` is monotonic per account and a skipped value
      // costs a pull nothing, whereas reusing one would let two different
      // changes share a stamp.
      const reconciled = results.map((item) =>
        item.status === "accepted"
          ? result(item.itemId, "duplicate", "duplicate")
          : item,
      );
      return {
        results: reconciled,
        adopted: 0,
        keptFromAccount: keptFromAccount + adopted,
        rejected,
        serverCursor: 0,
      };
    }

    return {
      results,
      adopted,
      keptFromAccount,
      rejected,
      serverCursor: cursor,
    };
  });
}
