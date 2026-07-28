ALTER TABLE "review_events" ADD COLUMN "imported_from_guest_import_id" uuid;--> statement-breakpoint
ALTER TABLE "study_components" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "study_components" ADD COLUMN "merged_from_guest_import_id" uuid;--> statement-breakpoint
ALTER TABLE "study_components" ADD CONSTRAINT "study_components_merge_provenance_check" CHECK (("study_components"."merged_at" IS NULL AND "study_components"."merged_from_guest_import_id" IS NULL)
          OR ("study_components"."merged_at" IS NOT NULL AND "study_components"."merged_from_guest_import_id" IS NOT NULL));