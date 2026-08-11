-- Dashboard users and role metadata migrated from Firebase Auth claims.
ALTER TABLE users ADD COLUMN IF NOT EXISTS dashboard_role TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS dashboard_sede_type TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS dashboard_sede_id TEXT;

CREATE INDEX IF NOT EXISTS idx_users_dashboard_role ON users(role, dashboard_role);
