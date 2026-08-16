CREATE TYPE "public"."ground_station_status" AS ENUM('AVAILABLE', 'OFFLINE', 'MAINTENANCE');--> statement-breakpoint
CREATE TYPE "public"."mission_task_status" AS ENUM('PENDING', 'SCHEDULED', 'COMPLETED', 'CANCELLED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."orbital_data_source" AS ENUM('CELESTRAK');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."satellite_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TABLE "contact_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"satellite_id" uuid NOT NULL,
	"ground_station_id" uuid NOT NULL,
	"orbital_data_id" uuid NOT NULL,
	"aos" timestamp with time zone NOT NULL,
	"los" timestamp with time zone NOT NULL,
	"duration_seconds" integer NOT NULL,
	"max_elevation_deg" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_windows_id_station_sat_aos_los_unique" UNIQUE("id","ground_station_id","satellite_id","aos","los"),
	CONSTRAINT "aos_los_check" CHECK ("contact_windows"."aos" < "contact_windows"."los"),
	CONSTRAINT "duration_check" CHECK ("contact_windows"."duration_seconds" > 0),
	CONSTRAINT "duration_math_check" CHECK (("contact_windows"."duration_seconds")::numeric = EXTRACT(EPOCH FROM ("contact_windows"."los" - "contact_windows"."aos"))),
	CONSTRAINT "max_elevation_check" CHECK ("contact_windows"."max_elevation_deg" >= 0 AND "contact_windows"."max_elevation_deg" <= 90)
);
--> statement-breakpoint
CREATE TABLE "ground_stations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"altitude_m" double precision DEFAULT 0 NOT NULL,
	"minimum_elevation_deg" double precision NOT NULL,
	"status" "ground_station_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ground_stations_code_unique" UNIQUE("code"),
	CONSTRAINT "latitude_check" CHECK ("ground_stations"."latitude" >= -90 AND "ground_stations"."latitude" <= 90),
	CONSTRAINT "longitude_check" CHECK ("ground_stations"."longitude" >= -180 AND "ground_stations"."longitude" <= 180),
	CONSTRAINT "elevation_check" CHECK ("ground_stations"."minimum_elevation_deg" >= 0 AND "ground_stations"."minimum_elevation_deg" <= 90),
	CONSTRAINT "altitude_check" CHECK ("ground_stations"."altitude_m" >= -500 AND "ground_stations"."altitude_m" <= 10000)
);
--> statement-breakpoint
CREATE TABLE "mission_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"satellite_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"priority" integer NOT NULL,
	"duration_seconds" integer NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"status" "mission_task_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mission_tasks_id_sat_dur_unique" UNIQUE("id","satellite_id","duration_seconds"),
	CONSTRAINT "priority_check" CHECK ("mission_tasks"."priority" >= 1 AND "mission_tasks"."priority" <= 10),
	CONSTRAINT "duration_check" CHECK ("mission_tasks"."duration_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_task_id" uuid NOT NULL,
	"contact_window_id" uuid NOT NULL,
	"ground_station_id" uuid NOT NULL,
	"satellite_id" uuid NOT NULL,
	"window_aos" timestamp with time zone NOT NULL,
	"window_los" timestamp with time zone NOT NULL,
	"task_duration_seconds" integer NOT NULL,
	"allocated_start" timestamp with time zone NOT NULL,
	"allocated_end" timestamp with time zone NOT NULL,
	"status" "reservation_status" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allocated_time_check" CHECK ("reservations"."allocated_start" < "reservations"."allocated_end"),
	CONSTRAINT "inside_window_check" CHECK ("reservations"."allocated_start" >= "reservations"."window_aos" AND "reservations"."allocated_end" <= "reservations"."window_los"),
	CONSTRAINT "duration_match_check" CHECK (("reservations"."task_duration_seconds")::numeric = EXTRACT(EPOCH FROM ("reservations"."allocated_end" - "reservations"."allocated_start")))
);
--> statement-breakpoint
CREATE TABLE "satellite_orbital_data" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"satellite_id" uuid NOT NULL,
	"source" "orbital_data_source" NOT NULL,
	"tle_line1" varchar(255) NOT NULL,
	"tle_line2" varchar(255) NOT NULL,
	"tle_epoch" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "satellite_orbital_data_id_sat_unique" UNIQUE("id","satellite_id")
);
--> statement-breakpoint
CREATE TABLE "satellites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"norad_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"status" "satellite_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "satellites_norad_id_unique" UNIQUE("norad_id"),
	CONSTRAINT "norad_id_check" CHECK ("satellites"."norad_id" > 0)
);
--> statement-breakpoint
ALTER TABLE "contact_windows" ADD CONSTRAINT "contact_windows_satellite_id_satellites_id_fk" FOREIGN KEY ("satellite_id") REFERENCES "public"."satellites"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_windows" ADD CONSTRAINT "contact_windows_ground_station_id_ground_stations_id_fk" FOREIGN KEY ("ground_station_id") REFERENCES "public"."ground_stations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_windows" ADD CONSTRAINT "contact_windows_orbital_sat_fk" FOREIGN KEY ("orbital_data_id","satellite_id") REFERENCES "public"."satellite_orbital_data"("id","satellite_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_tasks" ADD CONSTRAINT "mission_tasks_satellite_id_satellites_id_fk" FOREIGN KEY ("satellite_id") REFERENCES "public"."satellites"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_mission_task_fk" FOREIGN KEY ("mission_task_id","satellite_id","task_duration_seconds") REFERENCES "public"."mission_tasks"("id","satellite_id","duration_seconds") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_contact_window_fk" FOREIGN KEY ("contact_window_id","ground_station_id","satellite_id","window_aos","window_los") REFERENCES "public"."contact_windows"("id","ground_station_id","satellite_id","aos","los") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "satellite_orbital_data" ADD CONSTRAINT "satellite_orbital_data_satellite_id_satellites_id_fk" FOREIGN KEY ("satellite_id") REFERENCES "public"."satellites"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "satellite_id_idx" ON "mission_tasks" USING btree ("satellite_id");--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "exclude_overlapping_reservations_active" EXCLUDE USING gist ("ground_station_id" WITH =, tstzrange("allocated_start", "allocated_end") WITH &&) WHERE (status IN ('PENDING', 'CONFIRMED'));--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_reservation_per_task" ON "reservations" USING btree ("mission_task_id") WHERE status IN ('PENDING', 'CONFIRMED');