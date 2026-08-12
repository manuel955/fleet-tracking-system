-- Operational history owned by the VPS dashboard. Firebase history remains
-- untouched; new VPS sessions, alerts and feedback are written here.
CREATE TABLE IF NOT EXISTS driver_connection_history (
  id BIGSERIAL PRIMARY KEY,
  driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('online', 'offline')),
  reason TEXT,
  driver_name TEXT NOT NULL DEFAULT '',
  driver_plate TEXT NOT NULL DEFAULT '',
  event_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_driver_connection_history_driver_at
  ON driver_connection_history(driver_id, event_at DESC);

CREATE TABLE IF NOT EXISTS operation_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  driver_name TEXT NOT NULL DEFAULT '',
  driver_plate TEXT NOT NULL DEFAULT '',
  driver_phone TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT 'MANUAL',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  disconnected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  final_lat DOUBLE PRECISION,
  final_lng DOUBLE PRECISION,
  final_accuracy_m DOUBLE PRECISION,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_operation_alerts_created
  ON operation_alerts(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_operation_alerts_open_driver
  ON operation_alerts(driver_id) WHERE status = 'OPEN';

CREATE TABLE IF NOT EXISTS trip_feedback (
  trip_id UUID PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  passenger_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL,
  rating SMALLINT CHECK (rating BETWEEN 1 AND 5),
  comment TEXT NOT NULL DEFAULT '',
  incident_category TEXT NOT NULL DEFAULT 'none',
  incident_details TEXT NOT NULL DEFAULT '',
  incident_status TEXT NOT NULL DEFAULT 'NONE' CHECK (incident_status IN ('NONE', 'OPEN', 'RESOLVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_trip_feedback_incidents
  ON trip_feedback(updated_at DESC) WHERE incident_category <> 'none';
