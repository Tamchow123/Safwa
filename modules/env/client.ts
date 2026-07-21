/**
 * Client-safe environment values (Phase 15). Only `NEXT_PUBLIC_*` variables
 * belong here — Next.js inlines them into the client bundle at build time,
 * so `process.env.NEXT_PUBLIC_APP_URL` must appear literally (not through a
 * dynamic lookup) for that replacement to work. Never add a secret here.
 */
import { z } from "zod";

const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z
    .string()
    .url("NEXT_PUBLIC_APP_URL must be a valid URL")
    .optional(),
});

export type ClientEnv = {
  appUrl: string | undefined;
};

const parsed = clientEnvSchema.parse({
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
});

export const clientEnv: ClientEnv = {
  appUrl: parsed.NEXT_PUBLIC_APP_URL,
};
