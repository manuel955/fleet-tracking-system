CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role TEXT NOT NULL CHECK (role IN ('passenger', 'driver', 'dashboard')),
  email TEXT UNIQUE,
  password_hash TEXT,
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drivers (
  id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  approval_status TEXT NOT NULL DEFAULT 'pending_review',
  phone TEXT NOT NULL DEFAULT '',
  plate TEXT NOT NULL UNIQUE,
  vehicle_type TEXT NOT NULL DEFAULT 'Auto',
  vehicle_seats SMALLINT NOT NULL DEFAULT 4 CHECK (vehicle_seats > 0),
  availability_status TEXT NOT NULL DEFAULT 'offline',
  current_trip_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS driver_locations (
  driver_id UUID PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE,
  latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_m DOUBLE PRECISION,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  passenger_id UUID NOT NULL REFERENCES users(id),
  driver_id UUID REFERENCES drivers(id),
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'searching', 'accepted', 'arrived_at_pickup', 'in_progress', 'completed', 'cancelled', 'no_drivers_available')),
  origin_address TEXT NOT NULL,
  origin_lat DOUBLE PRECISION NOT NULL,
  origin_lng DOUBLE PRECISION NOT NULL,
  destination_address TEXT NOT NULL,
  destination_lat DOUBLE PRECISION NOT NULL,
  destination_lng DOUBLE PRECISION NOT NULL,
  scheduled_pickup_at TIMESTAMPTZ,
  passenger_count SMALLINT NOT NULL DEFAULT 1 CHECK (passenger_count BETWEEN 1 AND 45),
  cancelled_by TEXT,
  cancel_reason TEXT,
  completed_at TIMESTAMPTZ,
  rating SMALLINT CHECK (rating BETWEEN 1 AND 5),
  feedback_comment TEXT,
  feedback_submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE trips ADD COLUMN IF NOT EXISTS passenger_count SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS cancelled_by TEXT;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS rating SMALLINT;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS feedback_comment TEXT;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS feedback_submitted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_trips_status_created ON trips(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trips_driver_status ON trips(driver_id, status);
CREATE INDEX IF NOT EXISTS idx_trips_passenger_created ON trips(passenger_id, created_at DESC);

CREATE TABLE IF NOT EXISTS device_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_id UUID REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
