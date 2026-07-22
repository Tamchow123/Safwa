ALTER TABLE "study_attempts" DROP CONSTRAINT "study_attempts_option_count_check";--> statement-breakpoint
ALTER TABLE "review_events" ADD COLUMN "release_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "study_attempts" ADD COLUMN "release_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "study_sessions" ADD COLUMN "release_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_release_id_content_versions_release_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."content_versions"("release_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_attempts" ADD CONSTRAINT "study_attempts_release_id_content_versions_release_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."content_versions"("release_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_release_id_content_versions_release_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."content_versions"("release_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_attempts" ADD CONSTRAINT "study_attempts_option_count_check" CHECK ("study_attempts"."option_count" IS NULL OR "study_attempts"."option_count" BETWEEN 2 AND 8);