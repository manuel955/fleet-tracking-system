-- Operating place assigned to a driver from the VPS dashboard.
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS assigned_place JSONB;
