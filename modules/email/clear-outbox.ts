/**
 * Safe CLI to clear the local dev email outbox (Phase 15, phases-15.md
 * §40) — `pnpm email:clear-outbox`. Refuses to run in production: the
 * outbox only ever exists for the console-file transport, which
 * `modules/env/server.ts` already refuses to select in production
 * without the explicit `ALLOW_DEV_EMAIL_TRANSPORT_IN_PRODUCTION` escape
 * hatch — this CLI adds its own independent NODE_ENV check on top, since
 * clearing an outbox is an irreversible local action a developer might
 * run without first checking which environment they're in.
 *
 * Run via `tsx --conditions=react-server` (baked into the
 * `email:clear-outbox` script) — see db/migrate.ts for why plain `tsx`
 * cannot import this module's `server-only` dependency chain.
 */
import { pathToFileURL } from "node:url";
import { clearOutbox } from "@/modules/email/transports/console-file";
import { getServerEnv } from "@/modules/env/server";

export async function clearLocalOutbox(): Promise<void> {
  const env = getServerEnv();
  if (env.nodeEnv === "production") {
    throw new Error(
      "Refusing to clear the email outbox in production — this command is for local dev/test use only.",
    );
  }
  await clearOutbox(env.emailOutboxDir);
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  import("@/db/load-env")
    .then(clearLocalOutbox)
    .then(() => {
      console.log("Email outbox cleared.");
    })
    .catch((error: unknown) => {
      console.error("Failed to clear the email outbox:", error);
      process.exit(1);
    });
}
