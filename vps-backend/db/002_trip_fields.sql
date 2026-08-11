-- Idempotent migration for databases created before the VPS trip API.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS passenger_count SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS cancelled_by TEXT;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS rating SMALLINT;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS feedback_comment TEXT;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS feedback_submitted_at TIMESTAMPTZ;

UPDATE trips SET passenger_count = 1 WHERE passenger_count IS NULL;
