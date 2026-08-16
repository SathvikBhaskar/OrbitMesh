CREATE TYPE "public"."execution_status" AS ENUM('SUCCESS', 'FAILED_FEATURE_EXTRACTION', 'FAILED_EXECUTION', 'PARTIAL');--> statement-breakpoint
CREATE TYPE "public"."run_type" AS ENUM('PRODUCTION', 'LAB');--> statement-breakpoint
CREATE TABLE "scheduler_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_type" "run_type" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"reference_time" timestamp with time zone NOT NULL,
	"selected_policy" varchar(50),
	"selection_reason" text,
	"selector_version" varchar(50),
	"task_count" integer,
	"total_task_demand_seconds" double precision,
	"usable_capacity_seconds" double precision,
	"load_pressure" double precision,
	"median_deadline_pressure" double precision,
	"p10_deadline_pressure" double precision,
	"tight_task_fraction" double precision,
	"high_priority_fraction" double precision,
	"mean_gap_seconds" double precision,
	"largest_gap_seconds" double precision,
	"fragmentation_pressure" double precision,
	"scheduled_count" integer,
	"unscheduled_count" integer,
	"execution_status" "execution_status" NOT NULL,
	"error_message" text
);