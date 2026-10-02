-- Migration 0009: Phase 5.7 Transactional Outbox & Safety Interlocks

DO $$ BEGIN
  CREATE TYPE outbox_message_status AS ENUM (
    'PENDING',
    'DELIVERING',
    'DELIVERED',
    'RETRY',
    'DLQ'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE outbox_message_type AS ENUM (
    'STAGE_DISPATCH',
    'ARM_DISPATCH',
    'ABORT_PASS',
    'RF_INHIBIT',
    'STATUS_QUERY'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE execution_interlock_state AS ENUM (
    'NONE',
    'ABORT_REQUESTED',
    'ABORT_CONFIRMED',
    'ABORT_UNCONFIRMED',
    'RF_INHIBIT_REQUESTED',
    'RF_INHIBIT_CONFIRMED',
    'INTERLOCK_FAILED'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 1. Add interlock columns to reservations
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS execution_interlock execution_interlock_state NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS interlock_requested_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS interlock_confirmed_at TIMESTAMP WITH TIME ZONE;

-- 2. Create outbound_dispatch_messages table
CREATE TABLE IF NOT EXISTS outbound_dispatch_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id VARCHAR(64) NOT NULL UNIQUE,
  dispatch_id VARCHAR(64) NOT NULL REFERENCES dispatch_attempts(dispatch_id) ON DELETE RESTRICT,
  reservation_id UUID NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
  provider_id VARCHAR(64) NOT NULL,
  message_type outbox_message_type NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status outbox_message_status NOT NULL DEFAULT 'PENDING',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  last_attempt_at TIMESTAMP WITH TIME ZONE,
  last_error TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX IF NOT EXISTS outbound_dispatch_pending_idx ON outbound_dispatch_messages (status, next_attempt_at)
  WHERE status IN ('PENDING', 'RETRY');
CREATE INDEX IF NOT EXISTS outbound_dispatch_res_idx ON outbound_dispatch_messages (reservation_id);
CREATE INDEX IF NOT EXISTS outbound_dispatch_disp_idx ON outbound_dispatch_messages (dispatch_id);
