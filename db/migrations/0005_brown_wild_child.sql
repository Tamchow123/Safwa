ALTER TABLE "guest_imports" ADD COLUMN "reason_code" text;--> statement-breakpoint
ALTER TABLE "guest_imports" ADD CONSTRAINT "guest_imports_reason_code_check" CHECK ("guest_imports"."reason_code" IS NULL OR "guest_imports"."reason_code" IN (
            'accepted', 'already_completed', 'snapshot_mismatch', 'unknown_import',
            'incomplete_upload', 'declared_totals_exceeded', 'chunk_out_of_range',
            'list_ceiling_exceeded', 'cross_account_import', 'merge_disabled',
            'email_unverified', 'malformed_request', 'internal_error'));--> statement-breakpoint
ALTER TABLE "guest_imports" ADD CONSTRAINT "guest_imports_terminal_reason_check" CHECK ("guest_imports"."status" = 'open' OR "guest_imports"."reason_code" IS NOT NULL);