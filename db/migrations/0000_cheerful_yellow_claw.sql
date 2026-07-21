CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limits_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"role" text DEFAULT 'learner' NOT NULL,
	CONSTRAINT "users_role_check" CHECK ("users"."role" IN ('learner', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_activity" (
	"user_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"reviews" integer DEFAULT 0 NOT NULL,
	"new_items" integer DEFAULT 0 NOT NULL,
	"study_ms" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_activity_user_date_unique" UNIQUE("user_id","local_date"),
	CONSTRAINT "daily_activity_attempts_check" CHECK ("daily_activity"."attempts" >= 0),
	CONSTRAINT "daily_activity_reviews_check" CHECK ("daily_activity"."reviews" >= 0),
	CONSTRAINT "daily_activity_new_items_check" CHECK ("daily_activity"."new_items" >= 0),
	CONSTRAINT "daily_activity_study_ms_check" CHECK ("daily_activity"."study_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "review_events" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"study_component_id" uuid NOT NULL,
	"attempt_id" uuid,
	"rating" text NOT NULL,
	"status" text NOT NULL,
	"base_server_revision" bigint NOT NULL,
	"parent_event_id" uuid,
	"client_component_revision" bigint NOT NULL,
	"occurred_at_client" timestamp with time zone NOT NULL,
	"occurred_at_canonical" timestamp with time zone NOT NULL,
	"server_received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" text NOT NULL,
	"client_sequence" bigint NOT NULL,
	"session_id" uuid,
	"content_version" text NOT NULL,
	"timezone_at_event" text NOT NULL,
	"utc_offset_minutes_at_event" integer NOT NULL,
	"local_date_at_event" date NOT NULL,
	"timezone_source" text NOT NULL,
	"timezone_corrected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_events_rating_check" CHECK ("review_events"."rating" IN ('again', 'hard', 'good', 'easy')),
	CONSTRAINT "review_events_status_check" CHECK ("review_events"."status" IN ('scheduling', 'reinforcement', 'conflict_demoted', 'revoked', 'pending_parent')),
	CONSTRAINT "review_events_timezone_source_check" CHECK ("review_events"."timezone_source" IN ('browser_detected', 'user_setting', 'server_fallback')),
	CONSTRAINT "review_events_base_revision_check" CHECK ("review_events"."base_server_revision" >= 0),
	CONSTRAINT "review_events_client_revision_check" CHECK ("review_events"."client_component_revision" >= 0),
	CONSTRAINT "review_events_client_sequence_check" CHECK ("review_events"."client_sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "skill_types" (
	"id" text PRIMARY KEY NOT NULL,
	"component_shape" text NOT NULL,
	"display_name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "skill_types_id_shape_unique" UNIQUE("id","component_shape"),
	CONSTRAINT "skill_types_component_shape_check" CHECK ("skill_types"."component_shape" IN ('form_direction', 'entry_level'))
);
--> statement-breakpoint
CREATE TABLE "study_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid,
	"study_component_id" uuid,
	"entry_id" integer NOT NULL,
	"skill_type_id" text NOT NULL,
	"source_field" text,
	"direction" text,
	"prompt_field" text,
	"prompt_ref" jsonb NOT NULL,
	"selected_answer_ref" jsonb,
	"correct_answer_ref" jsonb NOT NULL,
	"is_correct" boolean NOT NULL,
	"is_first_attempt" boolean NOT NULL,
	"is_reinforcement" boolean NOT NULL,
	"hint_used" boolean DEFAULT false NOT NULL,
	"hint_type" text,
	"response_time_ms" integer,
	"question_position" integer NOT NULL,
	"mode" text NOT NULL,
	"option_count" integer,
	"per_question_limit_ms" integer,
	"question_instance_id" text NOT NULL,
	"question_seed" text NOT NULL,
	"question_generator_version" text NOT NULL,
	"occurred_at_utc" timestamp with time zone NOT NULL,
	"timezone_at_event" text NOT NULL,
	"utc_offset_minutes_at_event" integer NOT NULL,
	"local_date_at_event" date NOT NULL,
	"timezone_source" text NOT NULL,
	"device_id" text NOT NULL,
	"content_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "study_attempts_source_field_check" CHECK ("study_attempts"."source_field" IS NULL OR "study_attempts"."source_field" IN ('madi', 'mudari', 'masdar', 'ism_fail', 'amr', 'nahi')),
	CONSTRAINT "study_attempts_direction_check" CHECK ("study_attempts"."direction" IS NULL OR "study_attempts"."direction" IN ('arabic_to_english', 'english_to_arabic')),
	CONSTRAINT "study_attempts_mode_check" CHECK ("study_attempts"."mode" IN ('mc', 'flashcard', 'timed', 'test', 'timed_test')),
	CONSTRAINT "study_attempts_timezone_source_check" CHECK ("study_attempts"."timezone_source" IN ('browser_detected', 'user_setting', 'server_fallback')),
	CONSTRAINT "study_attempts_response_time_check" CHECK ("study_attempts"."response_time_ms" IS NULL OR "study_attempts"."response_time_ms" >= 0),
	CONSTRAINT "study_attempts_question_position_check" CHECK ("study_attempts"."question_position" >= 0),
	CONSTRAINT "study_attempts_option_count_check" CHECK ("study_attempts"."option_count" IS NULL OR "study_attempts"."option_count" >= 2),
	CONSTRAINT "study_attempts_time_limit_check" CHECK ("study_attempts"."per_question_limit_ms" IS NULL OR "study_attempts"."per_question_limit_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "study_components" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entry_id" integer NOT NULL,
	"skill_type_id" text NOT NULL,
	"component_shape" text NOT NULL,
	"source_field" text,
	"direction" text,
	"stability" double precision,
	"difficulty" double precision,
	"due_at" timestamp with time zone,
	"fsrs_state" text,
	"reps" integer DEFAULT 0 NOT NULL,
	"lapses" integer DEFAULT 0 NOT NULL,
	"last_review_at" timestamp with time zone,
	"revision" bigint DEFAULT 0 NOT NULL,
	"learner_state" text DEFAULT 'not_started' NOT NULL,
	CONSTRAINT "study_components_shape_check" CHECK (("study_components"."component_shape" = 'form_direction' AND "study_components"."source_field" IS NOT NULL AND "study_components"."direction" IS NOT NULL)
          OR ("study_components"."component_shape" = 'entry_level' AND "study_components"."source_field" IS NULL AND "study_components"."direction" IS NULL)),
	CONSTRAINT "study_components_source_field_check" CHECK ("study_components"."source_field" IS NULL OR "study_components"."source_field" IN ('madi', 'mudari', 'masdar', 'ism_fail', 'amr', 'nahi')),
	CONSTRAINT "study_components_direction_check" CHECK ("study_components"."direction" IS NULL OR "study_components"."direction" IN ('arabic_to_english', 'english_to_arabic')),
	CONSTRAINT "study_components_learner_state_check" CHECK ("study_components"."learner_state" IN ('not_started', 'learning', 'mastered', 'needs_review')),
	CONSTRAINT "study_components_fsrs_state_check" CHECK ("study_components"."fsrs_state" IS NULL OR "study_components"."fsrs_state" IN ('new', 'learning', 'review', 'relearning')),
	CONSTRAINT "study_components_reps_check" CHECK ("study_components"."reps" >= 0),
	CONSTRAINT "study_components_lapses_check" CHECK ("study_components"."lapses" >= 0),
	CONSTRAINT "study_components_revision_check" CHECK ("study_components"."revision" >= 0),
	CONSTRAINT "study_components_stability_check" CHECK ("study_components"."stability" IS NULL OR ("study_components"."stability" >= 0 AND "study_components"."stability" < 'infinity'::double precision)),
	CONSTRAINT "study_components_difficulty_check" CHECK ("study_components"."difficulty" IS NULL OR ("study_components"."difficulty" BETWEEN 0 AND 10))
);
--> statement-breakpoint
CREATE TABLE "study_sessions" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"config" jsonb NOT NULL,
	"content_version" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"question_count" integer,
	"first_attempt_correct" integer,
	"recovered" integer,
	"hinted" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "study_sessions_mode_check" CHECK ("study_sessions"."mode" IN ('mc', 'flashcard', 'timed', 'test', 'timed_test')),
	CONSTRAINT "study_sessions_aggregates_check" CHECK (("study_sessions"."question_count" IS NULL OR "study_sessions"."question_count" >= 0)
          AND ("study_sessions"."first_attempt_correct" IS NULL OR "study_sessions"."first_attempt_correct" >= 0)
          AND ("study_sessions"."recovered" IS NULL OR "study_sessions"."recovered" >= 0)
          AND ("study_sessions"."hinted" IS NULL OR "study_sessions"."hinted" >= 0))
);
--> statement-breakpoint
CREATE TABLE "bookmarks" (
	"user_id" uuid NOT NULL,
	"entry_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookmarks_user_entry_unique" UNIQUE("user_id","entry_id")
);
--> statement-breakpoint
CREATE TABLE "custom_list_entries" (
	"list_id" uuid NOT NULL,
	"entry_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_list_entries_list_entry_unique" UNIQUE("list_id","entry_id")
);
--> statement-breakpoint
CREATE TABLE "custom_lists" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"normalised_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_lists_user_normalised_name_unique" UNIQUE("user_id","normalised_name"),
	CONSTRAINT "custom_lists_name_length_check" CHECK (char_length("custom_lists"."name") BETWEEN 1 AND 60),
	CONSTRAINT "custom_lists_updated_not_before_created_check" CHECK ("custom_lists"."updated_at" >= "custom_lists"."created_at")
);
--> statement-breakpoint
CREATE TABLE "guest_imports" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"import_key" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"result" text NOT NULL,
	CONSTRAINT "guest_imports_import_key_unique" UNIQUE("import_key"),
	CONSTRAINT "guest_imports_result_check" CHECK ("guest_imports"."result" IN ('applied', 'no_op', 'rejected')),
	CONSTRAINT "guest_imports_event_count_check" CHECK ("guest_imports"."event_count" >= 0),
	CONSTRAINT "guest_imports_attempt_count_check" CHECK ("guest_imports"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"theme" text DEFAULT 'system' NOT NULL,
	"arabic_font_scale" text DEFAULT 'default' NOT NULL,
	"timezone_mode" text DEFAULT 'browser' NOT NULL,
	"timezone_name" text,
	"question_count" integer DEFAULT 20 NOT NULL,
	"option_count" integer DEFAULT 4 NOT NULL,
	"daily_new_target" integer DEFAULT 10 NOT NULL,
	"daily_review_target" integer DEFAULT 20 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_settings_theme_check" CHECK ("user_settings"."theme" IN ('light', 'dark', 'system')),
	CONSTRAINT "user_settings_arabic_font_scale_check" CHECK ("user_settings"."arabic_font_scale" IN ('small', 'default', 'large')),
	CONSTRAINT "user_settings_timezone_mode_check" CHECK ("user_settings"."timezone_mode" IN ('browser', 'iana')),
	CONSTRAINT "user_settings_timezone_shape_check" CHECK (("user_settings"."timezone_mode" = 'browser' AND "user_settings"."timezone_name" IS NULL)
          OR ("user_settings"."timezone_mode" = 'iana' AND "user_settings"."timezone_name" IS NOT NULL AND char_length("user_settings"."timezone_name") > 0)),
	CONSTRAINT "user_settings_question_count_check" CHECK ("user_settings"."question_count" BETWEEN 1 AND 100),
	CONSTRAINT "user_settings_option_count_check" CHECK ("user_settings"."option_count" BETWEEN 2 AND 8),
	CONSTRAINT "user_settings_daily_new_target_check" CHECK ("user_settings"."daily_new_target" BETWEEN 0 AND 100),
	CONSTRAINT "user_settings_daily_review_target_check" CHECK ("user_settings"."daily_review_target" BETWEEN 0 AND 500)
);
--> statement-breakpoint
CREATE TABLE "content_versions" (
	"release_id" text PRIMARY KEY NOT NULL,
	"content_version" text NOT NULL,
	"schema_version" text NOT NULL,
	"question_generator_version" text NOT NULL,
	"entry_count" integer NOT NULL,
	"checksum_learner" text NOT NULL,
	"checksum_validation" text NOT NULL,
	"checksum_assessment" text NOT NULL,
	"release_status" text NOT NULL,
	"minimum_supported_client_version" text NOT NULL,
	"minimum_supported_event_schema" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_versions_release_status_check" CHECK ("content_versions"."release_status" IN ('active', 'supported', 'revoked')),
	CONSTRAINT "content_versions_entry_count_check" CHECK ("content_versions"."entry_count" > 0),
	CONSTRAINT "content_versions_min_event_schema_check" CHECK ("content_versions"."minimum_supported_event_schema" > 0),
	CONSTRAINT "content_versions_checksum_learner_check" CHECK ("content_versions"."checksum_learner" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "content_versions_checksum_validation_check" CHECK ("content_versions"."checksum_validation" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "content_versions_checksum_assessment_check" CHECK ("content_versions"."checksum_assessment" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_activity" ADD CONSTRAINT "daily_activity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_study_component_id_study_components_id_fk" FOREIGN KEY ("study_component_id") REFERENCES "public"."study_components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_attempt_id_study_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."study_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_session_id_study_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."study_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_attempts" ADD CONSTRAINT "study_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_attempts" ADD CONSTRAINT "study_attempts_session_id_study_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."study_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_attempts" ADD CONSTRAINT "study_attempts_study_component_id_study_components_id_fk" FOREIGN KEY ("study_component_id") REFERENCES "public"."study_components"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_components" ADD CONSTRAINT "study_components_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_components" ADD CONSTRAINT "study_components_skill_shape_fk" FOREIGN KEY ("skill_type_id","component_shape") REFERENCES "public"."skill_types"("id","component_shape") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_list_entries" ADD CONSTRAINT "custom_list_entries_list_id_custom_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."custom_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_lists" ADD CONSTRAINT "custom_lists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_imports" ADD CONSTRAINT "guest_imports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_unique_idx" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "review_events_component_canonical_idx" ON "review_events" USING btree ("study_component_id","occurred_at_canonical");--> statement-breakpoint
CREATE INDEX "review_events_user_received_idx" ON "review_events" USING btree ("user_id","server_received_at");--> statement-breakpoint
CREATE INDEX "review_events_pending_parent_idx" ON "review_events" USING btree ("study_component_id") WHERE "review_events"."status" = 'pending_parent';--> statement-breakpoint
CREATE INDEX "study_attempts_user_occurred_idx" ON "study_attempts" USING btree ("user_id","occurred_at_utc");--> statement-breakpoint
CREATE INDEX "study_attempts_user_entry_idx" ON "study_attempts" USING btree ("user_id","entry_id");--> statement-breakpoint
CREATE INDEX "study_attempts_user_local_date_idx" ON "study_attempts" USING btree ("user_id","local_date_at_event");--> statement-breakpoint
CREATE INDEX "study_attempts_component_idx" ON "study_attempts" USING btree ("study_component_id");--> statement-breakpoint
CREATE INDEX "study_attempts_session_idx" ON "study_attempts" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "study_components_form_unique" ON "study_components" USING btree ("user_id","entry_id","skill_type_id","source_field","direction") WHERE "study_components"."component_shape" = 'form_direction';--> statement-breakpoint
CREATE UNIQUE INDEX "study_components_entry_unique" ON "study_components" USING btree ("user_id","entry_id","skill_type_id") WHERE "study_components"."component_shape" = 'entry_level';--> statement-breakpoint
CREATE INDEX "study_components_due_idx" ON "study_components" USING btree ("user_id","due_at");--> statement-breakpoint
CREATE INDEX "study_sessions_user_started_idx" ON "study_sessions" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "custom_list_entries_entry_idx" ON "custom_list_entries" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "custom_lists_user_idx" ON "custom_lists" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "guest_imports_user_imported_idx" ON "guest_imports" USING btree ("user_id","imported_at");--> statement-breakpoint
CREATE UNIQUE INDEX "content_versions_single_active_idx" ON "content_versions" USING btree ("release_status") WHERE "content_versions"."release_status" = 'active';