/**
 * Loads `.env.local` for standalone Node CLI scripts (db/migrate.ts,
 * db/reset-test-database.ts). Next.js's automatic env-file loading only
 * applies inside `next dev`/`build`/`start` — a plain `tsx` invocation sees
 * nothing unless it loads the file itself. Must be imported FIRST, before
 * any module that reads `process.env` (e.g. modules/env/server.ts). A
 * missing file is silently ignored (CI sets real environment variables
 * directly instead).
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
