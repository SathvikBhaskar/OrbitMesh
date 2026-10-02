CREATE TABLE IF NOT EXISTS "operational_event_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "idempotency_key" varchar(255) NOT NULL UNIQUE,
  "event_type" varchar(50) NOT NULL,
  "urgency" varchar(20) DEFAULT 'COALESCIBLE' NOT NULL,
  "payload" jsonb NOT NULL,
  "status" varchar(50) DEFAULT 'RECEIVED' NOT NULL,
  "batch_id" uuid,
  "execution_receipt" jsonb,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "operational_event_ledger_idempotency_key_idx" ON "operational_event_ledger" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "operational_event_ledger_status_idx" ON "operational_event_ledger" ("status");
CREATE INDEX IF NOT EXISTS "operational_event_ledger_batch_id_idx" ON "operational_event_ledger" ("batch_id");

CREATE TABLE IF NOT EXISTS "operational_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "status" varchar(50) DEFAULT 'PROCESSING' NOT NULL,
  "schedule_version_before" integer NOT NULL,
  "schedule_version_after" integer NOT NULL,
  "event_count" integer DEFAULT 0 NOT NULL,
  "event_ids" jsonb NOT NULL,
  "summary" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "operational_batches_status_idx" ON "operational_batches" ("status");
