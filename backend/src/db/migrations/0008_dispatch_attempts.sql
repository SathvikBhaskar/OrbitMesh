-- Migration 0008: Ground Adapter Dispatch Attempts & Transport Resilience
-- Defines the dispatch attempt handshake states and adapter transport health

DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dispatch_handshake_state') THEN
    CREATE TYPE dispatch_handshake_state AS ENUM (
      'PREPARED',
      'STAGED_ACK',
      'ARMED',
      'REJECTED',
      'EXPIRED'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'adapter_transport_health') THEN
    CREATE TYPE adapter_transport_health AS ENUM (
      'CONNECTED',
      'COMMUNICATION_GAP'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS dispatch_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  dispatch_id VARCHAR(64) NOT NULL UNIQUE,
  attempt_number INT NOT NULL DEFAULT 1,
  state dispatch_handshake_state NOT NULL DEFAULT 'PREPARED',
  transport_health adapter_transport_health NOT NULL DEFAULT 'CONNECTED',
  clock_offset_ms INT DEFAULT 0,
  staged_at TIMESTAMPTZ,
  armed_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  retry_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_dispatch_attempt_num UNIQUE (reservation_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_attempts_res_id ON dispatch_attempts(reservation_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_attempts_state ON dispatch_attempts(state);
