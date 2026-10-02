DO $$ BEGIN
  CREATE TYPE "execution_state" AS ENUM (
    'SCHEDULED',
    'EXECUTION_READY',
    'DISPATCHED',
    'IN_PROGRESS',
    'COMPLETED',
    'PARTIAL',
    'FAILED'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "execution_failure_reason" AS ENUM (
    'DISPATCH_REJECTED',
    'NO_AOS',
    'GROUND_HARDWARE_FAULT',
    'SATELLITE_UNAVAILABLE',
    'EXECUTION_ABORTED',
    'TIMEOUT',
    'UNKNOWN'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "reservations"
  ADD COLUMN IF NOT EXISTS "execution_state" "execution_state" DEFAULT 'SCHEDULED' NOT NULL,
  ADD COLUMN IF NOT EXISTS "active_dispatch_id" varchar(64),
  ADD COLUMN IF NOT EXISTS "dispatched_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "dispatch_ack_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "aos_actual" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "los_actual" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "bytes_transferred" bigint DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "failure_reason" "execution_failure_reason",
  ADD COLUMN IF NOT EXISTS "telemetry_metrics" jsonb DEFAULT '{}'::jsonb NOT NULL;

CREATE INDEX IF NOT EXISTS "reservations_execution_state_idx" ON "reservations" ("execution_state");
CREATE INDEX IF NOT EXISTS "reservations_active_dispatch_id_idx" ON "reservations" ("active_dispatch_id");

ALTER TABLE "mission_tasks"
  ADD COLUMN IF NOT EXISTS "target_bytes" bigint DEFAULT 1000000000 NOT NULL,
  ADD COLUMN IF NOT EXISTS "fulfilled_bytes" bigint DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "remaining_bytes" bigint DEFAULT 1000000000 NOT NULL;

DO $$ BEGIN
  ALTER TABLE "mission_tasks" ADD CONSTRAINT "mission_tasks_bytes_consistency_check"
    CHECK ("fulfilled_bytes" >= 0 AND "fulfilled_bytes" <= "target_bytes" AND "remaining_bytes" = "target_bytes" - "fulfilled_bytes");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "execution_telemetry_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "reservation_id" uuid NOT NULL REFERENCES "reservations"("id") ON DELETE CASCADE,
  "dispatch_id" varchar(64) NOT NULL,
  "event_type" varchar(64) NOT NULL,
  "sequence_number" integer NOT NULL,
  "source_timestamp" timestamp with time zone NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "idempotency_key" varchar(128) NOT NULL UNIQUE,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "execution_telemetry_events_res_dispatch_idx" ON "execution_telemetry_events" ("reservation_id", "dispatch_id");
CREATE INDEX IF NOT EXISTS "execution_telemetry_events_res_seq_idx" ON "execution_telemetry_events" ("reservation_id", "sequence_number");
