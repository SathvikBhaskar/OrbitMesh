CREATE TYPE "public"."orbital_sync_status" AS ENUM('RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."reservation_source" AS ENUM('AUTOMATED', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('VIEWER', 'OPERATOR', 'ADMIN');--> statement-breakpoint
CREATE TABLE "orbital_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"status" "orbital_sync_status" NOT NULL,
	"provider" varchar(255) NOT NULL,
	"requested_satellite_count" integer,
	"fetched_count" integer,
	"discovered_count" integer,
	"updated_count" integer,
	"ignored_count" integer,
	"rejected_count" integer,
	"regenerated_satellite_count" integer,
	"regenerated_window_count" integer,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(255) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "schedule_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" varchar(255) NOT NULL,
	"action" varchar(50) NOT NULL,
	"before_state" jsonb,
	"after_state" jsonb,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_versions" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"role" "user_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "source" "reservation_source" DEFAULT 'AUTOMATED' NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_audit_log" ADD CONSTRAINT "schedule_audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_token_hash_idx" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
ALTER TABLE "contact_windows" ADD CONSTRAINT "contact_windows_station_sat_aos_los_orbital_unique" UNIQUE("ground_station_id","satellite_id","aos","los","orbital_data_id");--> statement-breakpoint
ALTER TABLE "satellite_orbital_data" ADD CONSTRAINT "satellite_orbital_data_sat_epoch_unique" UNIQUE("satellite_id","tle_epoch");