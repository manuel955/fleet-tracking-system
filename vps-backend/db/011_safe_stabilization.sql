-- Security and data-consistency additions. Existing passengers are marked as
-- legacy-authorized once; new passenger accounts must originate from a QR.
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;

UPDATE users
   SET passenger_access_status = 'authorized'
 WHERE role = 'passenger' AND passenger_access_status IS NULL;

ALTER TABLE trips ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS requested_passenger_name TEXT;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS requested_passenger_phone TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_trips_passenger_request
  ON trips(passenger_id, request_id)
  WHERE request_id IS NOT NULL;
