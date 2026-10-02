ALTER TABLE "ground_stations" ADD COLUMN IF NOT EXISTS "supported_frequency_bands" text[] DEFAULT ARRAY['S_BAND', 'X_BAND']::text[] NOT NULL;
ALTER TABLE "ground_stations" ADD COLUMN IF NOT EXISTS "max_concurrent_contacts" integer DEFAULT 1 NOT NULL;
ALTER TABLE "ground_stations" ADD COLUMN IF NOT EXISTS "max_data_rate_mbps" double precision DEFAULT 100.0 NOT NULL;

DO $$ BEGIN
 ALTER TABLE "ground_stations" ADD CONSTRAINT "max_concurrent_contacts_check" CHECK ("ground_stations"."max_concurrent_contacts" > 0);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "ground_stations" ADD CONSTRAINT "max_data_rate_check" CHECK ("ground_stations"."max_data_rate_mbps" > 0);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "mission_tasks" ADD COLUMN IF NOT EXISTS "required_frequency_band" text DEFAULT 'S_BAND' NOT NULL;
ALTER TABLE "mission_tasks" ADD COLUMN IF NOT EXISTS "min_data_rate_mbps" double precision DEFAULT 10.0 NOT NULL;

DO $$ BEGIN
 ALTER TABLE "mission_tasks" ADD CONSTRAINT "min_data_rate_check" CHECK ("mission_tasks"."min_data_rate_mbps" > 0);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "reservations" DROP CONSTRAINT IF EXISTS "exclude_overlapping_reservations_active";
