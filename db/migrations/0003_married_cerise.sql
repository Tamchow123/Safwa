ALTER TABLE "guest_imports" DROP CONSTRAINT "guest_imports_result_check";--> statement-breakpoint
ALTER TABLE "guest_imports" ALTER COLUMN "result" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "guest_imports" ADD COLUMN "snapshot_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "guest_imports" ADD COLUMN "status" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "guest_imports" ADD COLUMN "declared_items" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "guest_imports" ADD COLUMN "accepted_items" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "guest_imports" ADD COLUMN "next_chunk_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "guest_imports" ADD COLUMN "accepted_lists" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "guest_imports" ADD COLUMN "final_server_cursor" bigint;--> statement-breakpoint
ALTER TABLE "guest_imports" ADD COLUMN "summary" jsonb;--> statement-breakpoint
ALTER TABLE "guest_imports" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "guest_imports_key_idx" ON "guest_imports" USING btree ("import_key");--> statement-breakpoint
CREATE UNIQUE INDEX "guest_imports_user_snapshot_completed_idx" ON "guest_imports" USING btree ("user_id","snapshot_hash") WHERE "guest_imports"."status" = 'completed';--> statement-breakpoint
ALTER TABLE "guest_imports" ADD CONSTRAINT "guest_imports_status_check" CHECK ("guest_imports"."status" IN ('open', 'completed', 'rejected'));--> statement-breakpoint
ALTER TABLE "guest_imports" ADD CONSTRAINT "guest_imports_completion_check" CHECK (("guest_imports"."status" = 'open' AND "guest_imports"."completed_at" IS NULL
           AND ("guest_imports"."result" IS NULL OR "guest_imports"."result" = 'incomplete'))
          OR ("guest_imports"."status" = 'completed' AND "guest_imports"."completed_at" IS NOT NULL
              AND "guest_imports"."result" IS NOT NULL
              AND "guest_imports"."result" IN ('applied', 'no_op'))
          OR ("guest_imports"."status" = 'rejected' AND "guest_imports"."completed_at" IS NOT NULL
              AND "guest_imports"."result" IS NOT NULL
              AND "guest_imports"."result" = 'rejected'));--> statement-breakpoint
ALTER TABLE "guest_imports" ADD CONSTRAINT "guest_imports_snapshot_hash_check" CHECK ("guest_imports"."snapshot_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "guest_imports" ADD CONSTRAINT "guest_imports_summary_numeric_check" CHECK ("guest_imports"."summary" IS NULL
          OR (jsonb_typeof("guest_imports"."summary") = 'object'
              AND NOT jsonb_path_exists("guest_imports"."summary", '$.* ? (@.type() != "number")')));--> statement-breakpoint
ALTER TABLE "guest_imports" ADD CONSTRAINT "guest_imports_declared_items_check" CHECK ("guest_imports"."declared_items" >= 0);--> statement-breakpoint
ALTER TABLE "guest_imports" ADD CONSTRAINT "guest_imports_accepted_items_check" CHECK ("guest_imports"."accepted_items" >= 0);--> statement-breakpoint
ALTER TABLE "guest_imports" ADD CONSTRAINT "guest_imports_next_chunk_index_check" CHECK ("guest_imports"."next_chunk_index" >= 0);--> statement-breakpoint
ALTER TABLE "guest_imports" ADD CONSTRAINT "guest_imports_accepted_lists_check" CHECK ("guest_imports"."accepted_lists" >= 0);--> statement-breakpoint
ALTER TABLE "guest_imports" ADD CONSTRAINT "guest_imports_final_server_cursor_check" CHECK ("guest_imports"."final_server_cursor" IS NULL OR "guest_imports"."final_server_cursor" >= 0);--> statement-breakpoint
ALTER TABLE "guest_imports" ADD CONSTRAINT "guest_imports_result_check" CHECK ("guest_imports"."result" IS NULL OR "guest_imports"."result" IN ('applied', 'no_op', 'rejected', 'incomplete'));