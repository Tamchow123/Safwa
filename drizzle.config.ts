import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";

// drizzle-kit is a standalone CLI, not run through Next.js's own env
// loader — load the developer's local override file explicitly. Silently
// does nothing if the file doesn't exist (e.g. CI, which sets DATABASE_URL
// directly in the environment).
loadEnv({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required to run drizzle-kit (set it in .env.local or the environment).",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
});
