-- ============================================================================
-- Esquema alternativo en PostgreSQL para el sistema de rastreo de flotas.
--
-- Nota: PostgreSQL no empuja datos a clientes por si solo. Si eliges esta
-- ruta en vez de Firebase, necesitas una capa adicional de tiempo real:
--   - Supabase (Postgres + Realtime vía replicacion logica y websockets), o
--   - Un servidor propio (Node/Express + Socket.io) que escuche NOTIFY/LISTEN
--     y reenvie los cambios a los clientes conectados.
-- La implementacion de referencia de este proyecto usa Firebase Realtime
-- Database (ver database/firebase-rules.json) porque resuelve el "push en
-- tiempo real" sin infraestructura adicional. Este script se deja como
-- alternativa documentada para equipos que prefieran una base relacional
-- autoalojada.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE drivers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(120) NOT NULL,
    age             SMALLINT NOT NULL CHECK (age > 17 AND age < 100),
    plate           VARCHAR(20) NOT NULL UNIQUE,
    phone           VARCHAR(20) NOT NULL,
    hotel_assigned  VARCHAR(150),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE driver_locations (
    driver_id       UUID PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE,
    latitude        DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude       DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    last_update     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Historial opcional de posiciones, util para reportes o replay de rutas.
CREATE TABLE driver_location_history (
    id              BIGSERIAL PRIMARY KEY,
    driver_id       UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
    latitude        DOUBLE PRECISION NOT NULL,
    longitude       DOUBLE PRECISION NOT NULL,
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_driver_location_history_driver_time
    ON driver_location_history (driver_id, recorded_at DESC);

-- Mantiene driver_locations actualizado y alimenta el historial en cada insert.
CREATE OR REPLACE FUNCTION upsert_driver_location(
    p_driver_id UUID,
    p_lat DOUBLE PRECISION,
    p_lng DOUBLE PRECISION
) RETURNS VOID AS $$
BEGIN
    INSERT INTO driver_locations (driver_id, latitude, longitude, last_update)
    VALUES (p_driver_id, p_lat, p_lng, now())
    ON CONFLICT (driver_id)
    DO UPDATE SET latitude = EXCLUDED.latitude,
                  longitude = EXCLUDED.longitude,
                  last_update = now();

    INSERT INTO driver_location_history (driver_id, latitude, longitude)
    VALUES (p_driver_id, p_lat, p_lng);
END;
$$ LANGUAGE plpgsql;

-- Vista lista para consumir desde el dashboard (join conductor + ubicacion).
CREATE VIEW fleet_status AS
SELECT
    d.id,
    d.name,
    d.age,
    d.plate,
    d.phone,
    d.hotel_assigned,
    l.latitude,
    l.longitude,
    l.last_update
FROM drivers d
LEFT JOIN driver_locations l ON l.driver_id = d.id;

-- Ejemplo de uso desde la app del conductor cada 30 segundos:
-- SELECT upsert_driver_location('driver-uuid-aqui', 19.432608, -99.133209);
