CREATE TABLE "conversation_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"session_id" varchar(255),
	"message_id" varchar(255) NOT NULL,
	"role" varchar(32) NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"strength" integer DEFAULT 1 NOT NULL,
	"last_accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	CONSTRAINT "conversation_messages_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "daily_summaries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"summary_date" date NOT NULL,
	"summary_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"strength" integer DEFAULT 3 NOT NULL,
	"last_accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	CONSTRAINT "daily_summaries_user_id_summary_date_key" UNIQUE("user_id","summary_date")
);
--> statement-breakpoint
CREATE TABLE "memory_conflicts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"trait_key" varchar(255) NOT NULL,
	"old_value" text,
	"new_value" text NOT NULL,
	"old_strength" integer,
	"new_strength" integer,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"status" varchar(32) DEFAULT 'pending',
	"metadata" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE "user_global_memory" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"global_summary_text" text,
	"portrait_text" text,
	"traits_json" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"strength" integer DEFAULT 5 NOT NULL,
	"last_accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"password" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_summaries" ADD CONSTRAINT "daily_summaries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_conflicts" ADD CONSTRAINT "memory_conflicts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_global_memory" ADD CONSTRAINT "user_global_memory_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_conversation_messages_user_id_created" ON "conversation_messages" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_conversation_messages_user_id_last_accessed" ON "conversation_messages" USING btree ("user_id","last_accessed_at");--> statement-breakpoint
CREATE INDEX "idx_conversation_messages_message_id" ON "conversation_messages" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_daily_summaries_user_id_date" ON "daily_summaries" USING btree ("user_id","summary_date");--> statement-breakpoint
CREATE INDEX "idx_memory_conflicts_user_id_detected" ON "memory_conflicts" USING btree ("user_id","detected_at");