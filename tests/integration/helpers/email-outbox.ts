import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getServerEnv } from "@/modules/env/server";

type OutboxRecord = {
  id: string;
  template: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  createdAt: string;
};

/**
 * Reads the most recently written console-file outbox message for a given
 * recipient (and optionally template), so integration tests can extract a
 * real verification/reset/delete-account token exactly the way a learner's
 * emailed link would carry it — never a hand-typed or fabricated token.
 */
export async function latestOutboxMessage(
  to: string,
  template?: string,
): Promise<OutboxRecord | null> {
  const outboxDir = getServerEnv().emailOutboxDir;
  let files: string[];
  try {
    files = await readdir(outboxDir);
  } catch {
    return null;
  }

  const candidates: { record: OutboxRecord; mtimeMs: number }[] = [];
  for (const file of files) {
    if (!file.endsWith(".json") || file.startsWith(".")) continue;
    const filePath = path.join(outboxDir, file);
    const [content, stats] = await Promise.all([
      readFile(filePath, "utf8"),
      stat(filePath),
    ]);
    const record = JSON.parse(content) as OutboxRecord;
    if (record.to !== to) continue;
    if (template && record.template !== template) continue;
    candidates.push({ record, mtimeMs: stats.mtimeMs });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]!.record;
}

/**
 * Extracts the token from a message's URL. Verify-email and delete-account
 * links carry it as a `?token=...` query param; the reset-password link
 * carries it as a path segment (`/reset-password/<token>?callbackURL=`) —
 * both are real Better Auth URL shapes, verified against the installed
 * package's route definitions, not assumed to be uniform.
 */
export function extractTokenFromMessage(message: OutboxRecord): string {
  const queryMatch = message.text.match(/[?&]token=([^&\s]+)/);
  if (queryMatch) return decodeURIComponent(queryMatch[1]!);

  const pathMatch = message.text.match(/\/reset-password\/([^/?\s]+)(?:\?|$)/);
  if (pathMatch) return decodeURIComponent(pathMatch[1]!);

  throw new Error(
    `extractTokenFromMessage: no token found in message to ${message.to}`,
  );
}
