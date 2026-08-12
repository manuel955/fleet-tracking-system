-- Keep the timestamps needed for a truthful dashboard average. Existing
-- trips without a start timestamp are excluded from the average.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS in_progress_at TIMESTAMPTZ;
