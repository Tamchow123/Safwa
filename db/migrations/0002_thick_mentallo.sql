CREATE TABLE "sync_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"item_kind" text NOT NULL,
	"item_id" text NOT NULL,
	"reason_code" text NOT NULL,
	"severity" text NOT NULL,
	"release_id" text,
	"component_key" text,
	"correlation_id" text,
	"clock_suspect" boolean DEFAULT false NOT NULL,
	"timezone_corrected" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_audit_log_item_kind_check" CHECK ("sync_audit_log"."item_kind" IN ('attempt', 'event', 'revocation', 'bookmark', 'list', 'setting')),
	CONSTRAINT "sync_audit_log_severity_check" CHECK ("sync_audit_log"."severity" IN ('info', 'warning', 'critical'))
);
--> statement-breakpoint
CREATE TABLE "sync_tombstones" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"last_sync_seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_tombstones_user_kind_ref_unique" UNIQUE("user_id","kind","ref"),
	CONSTRAINT "sync_tombstones_kind_check" CHECK ("sync_tombstones"."kind" IN ('bookmark', 'list')),
	CONSTRAINT "sync_tombstones_seq_check" CHECK ("sync_tombstones"."last_sync_seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_sync_state" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"sync_revision" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_events" ADD COLUMN "clock_suspect" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "review_events" ADD COLUMN "idempotency_payload_hash" text;--> statement-breakpoint
ALTER TABLE "review_events" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_events" ADD COLUMN "pending_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_events" ADD COLUMN "last_sync_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "study_attempts" ADD COLUMN "idempotency_payload_hash" text;--> statement-breakpoint
ALTER TABLE "study_components" ADD COLUMN "last_sync_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD COLUMN "last_sync_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_lists" ADD COLUMN "last_sync_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "last_sync_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_audit_log" ADD CONSTRAINT "sync_audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_tombstones" ADD CONSTRAINT "sync_tombstones_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sync_state" ADD CONSTRAINT "user_sync_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_audit_log_user_created_idx" ON "sync_audit_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "sync_tombstones_user_seq_idx" ON "sync_tombstones" USING btree ("user_id","last_sync_seq");--> statement-breakpoint
CREATE INDEX "review_events_sync_idx" ON "review_events" USING btree ("user_id","last_sync_seq") WHERE "review_events"."last_sync_seq" > 0;--> statement-breakpoint
CREATE INDEX "study_components_sync_idx" ON "study_components" USING btree ("user_id","last_sync_seq") WHERE "study_components"."last_sync_seq" > 0;--> statement-breakpoint
CREATE INDEX "bookmarks_user_seq_idx" ON "bookmarks" USING btree ("user_id","last_sync_seq") WHERE "bookmarks"."last_sync_seq" > 0;--> statement-breakpoint
CREATE INDEX "custom_lists_sync_idx" ON "custom_lists" USING btree ("user_id","last_sync_seq") WHERE "custom_lists"."last_sync_seq" > 0;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_last_sync_seq_check" CHECK ("review_events"."last_sync_seq" >= 0);--> statement-breakpoint
ALTER TABLE "study_components" ADD CONSTRAINT "study_components_last_sync_seq_check" CHECK ("study_components"."last_sync_seq" >= 0);--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_last_sync_seq_check" CHECK ("bookmarks"."last_sync_seq" >= 0);--> statement-breakpoint
ALTER TABLE "custom_lists" ADD CONSTRAINT "custom_lists_last_sync_seq_check" CHECK ("custom_lists"."last_sync_seq" >= 0);--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_last_sync_seq_check" CHECK ("user_settings"."last_sync_seq" >= 0);