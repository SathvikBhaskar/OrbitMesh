-- Migration 0010: Phase 5.7 Ground Station Credentials & Security Provenance

DO $$ BEGIN
  CREATE TYPE station_credential_status AS ENUM ('ACTIVE', 'ROTATING', 'REVOKED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS ground_station_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ground_station_id UUID NOT NULL REFERENCES ground_stations(id) ON DELETE CASCADE,
  key_id VARCHAR(64) NOT NULL UNIQUE,
  secret_key VARCHAR(255) NOT NULL,
  status station_credential_status NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  revoked_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_gs_credentials_station ON ground_station_credentials(ground_station_id);
CREATE INDEX IF NOT EXISTS idx_gs_credentials_key_id ON ground_station_credentials(key_id);
CREATE INDEX IF NOT EXISTS idx_gs_credentials_status ON ground_station_credentials(status);
