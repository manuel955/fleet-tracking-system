-- Hotel QR access migrated from Firebase RTDB.
ALTER TABLE users ADD COLUMN IF NOT EXISTS passenger_access_invite_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS passenger_access_status TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS passenger_access_expires_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS passenger_invites (
  id TEXT PRIMARY KEY,
  hotel_id TEXT NOT NULL,
  hotel_name TEXT NOT NULL,
  hotel_address TEXT NOT NULL DEFAULT '',
  hotel_lat DOUBLE PRECISION,
  hotel_lng DOUBLE PRECISION,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 100),
  uses INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used', 'revoked', 'expired')),
  last_used_at TIMESTAMPTZ,
  used_by JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_passenger_invites_created ON passenger_invites(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_passenger_invite ON users(passenger_access_invite_id);
