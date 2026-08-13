-- Document/profile fields used by the VPS registration flows. Existing
-- Firebase profile data remains untouched until an operator verifies it.
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS age SMALLINT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS dni TEXT NOT NULL DEFAULT '';
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_brand TEXT NOT NULL DEFAULT '';
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_color TEXT NOT NULL DEFAULT '';
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS profile_photo_url TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS dni_doc_url TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS dni_front_doc_url TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS dni_back_doc_url TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS license_doc_url TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS soat_doc_url TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS circulation_card_doc_url TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS technical_review_doc_url TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS criminal_record_doc_url TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS work_certificate_doc_url TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS license_expires_at BIGINT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS soat_expires_at BIGINT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS technical_review_expires_at BIGINT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS application_submitted_at TIMESTAMPTZ;
-- Dashboard-assigned operating location shared by the VPS dashboard and app.
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS assigned_place JSONB;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS rejection_field_keys TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS reviewed_at BIGINT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS suspended BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS suspension_reason TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS suspended_at BIGINT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS suspended_by TEXT;

CREATE TABLE IF NOT EXISTS passenger_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  phone TEXT NOT NULL DEFAULT '',
  credential_photo_url TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
