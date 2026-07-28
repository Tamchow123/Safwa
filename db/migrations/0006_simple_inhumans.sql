CREATE TABLE "guest_import_list_mappings" (
	"import_id" uuid NOT NULL,
	"guest_list_id" uuid NOT NULL,
	"account_list_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_import_list_mappings_import_id_guest_list_id_pk" PRIMARY KEY("import_id","guest_list_id")
);
--> statement-breakpoint
ALTER TABLE "guest_import_list_mappings" ADD CONSTRAINT "guest_import_list_mappings_import_id_guest_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."guest_imports"("id") ON DELETE cascade ON UPDATE no action;