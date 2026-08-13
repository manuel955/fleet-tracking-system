# APL Logistics VPS backend

Esta carpeta contiene el backend operativo que corre en Contabo. El VPS es la
fuente de verdad para usuarios propios, disponibilidad, GPS, viajes,
asignación, cancelación y calificaciones. Firebase se conserva de forma
intencional como proveedor de identidad del dashboard y como FCM para
notificaciones push de Android.

## Servicios

- API Node.js en `127.0.0.1:8080`.
- PostgreSQL 16 para usuarios, conductores, viajes y auditoría.
- Redis 7 para colas/estado efímero en tiempo real.
- MinIO para documentos y archivos compatibles con S3.

## Ejecutar localmente

```powershell
Copy-Item .env.example .env
# Edita .env y cambia todos los secretos `change-me`.
npm install
npm test
docker compose up -d --build
Invoke-WebRequest http://127.0.0.1:8080/health
```

## Despliegue en Contabo

1. Instalar Docker Engine y Compose en Ubuntu LTS.
2. Clonar el repositorio en una carpeta privada.
3. Crear `.env` fuera de Git con contraseñas aleatorias.
4. Ejecutar `docker compose up -d --build`.
5. Publicar únicamente el API mediante Nginx/Caddy con HTTPS.
6. Activar backups de PostgreSQL y MinIO antes de migrar usuarios reales.

En el VPS actual el API queda aislado en `127.0.0.1:8080` y no se mezcla con
el Caddy ni con la red Docker del POS. El POS usa su propia configuración y
no debe reutilizarse para publicar este API. Antes de exponerlo habrá que
provisionar un dominio/proxy independiente, con una ventana de mantenimiento
y una prueba de recuperación del POS.

## Contrato disponible

- `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `GET /api/v1/auth/me` y
  `POST /api/v1/auth/delete-account` (eliminación segura de conductor o pasajero VPS).
- `POST /api/v1/auth/request-password-reset` y `POST /api/v1/auth/reset-password`. La recuperación usa Resend cuando `.env` contiene `RESEND_API_KEY` y `MAIL_FROM`; sin ellos responde 503 de forma explícita.
- `GET /api/v1/drivers/me`, `POST /api/v1/drivers/availability` y
  `POST /api/v1/drivers/location` para conductores aprobados.
- `POST /api/v1/trips`, `GET /api/v1/trips`, `GET /api/v1/trips/:id`,
  `POST /api/v1/trips/:id/cancel` y `POST /api/v1/trips/:id/retry`.
- `GET /api/v1/trips/:id/driver-location` devuelve la ultima ubicacion del
  conductor solo al pasajero propietario de ese viaje.
- `POST /api/v1/trips/:id/action` para `arrive`, `start` y `complete`, y
  `POST /api/v1/trips/:id/feedback` para la calificación del pasajero.
- `POST /api/v1/device-tokens` registra el token del dispositivo; el envío
  push se mantiene en Firebase FCM para que Android pueda entregar alertas
  cuando la app está minimizada o cerrada.
- `GET /api/v1/dashboard/overview` entrega mapa, conductores, viajes y
  contadores desde PostgreSQL. Acepta el token Firebase del dashboard cuando
  tiene un custom claim de dashboard.

El despachador del backend revisa cada 15 segundos los viajes programados cuya
hora ya llegó y los pasa al emparejamiento transaccional. Si no hay un
conductor aprobado y disponible, el viaje queda en `no_drivers_available` y
puede reintentarse desde el endpoint de reintento.

## Estado de la migración

Las APK de laboratorio se compilan con
`VPS_API_BASE_URL=https://api.tucomprass.com`. El dashboard publicado en
`https://apl.tucomprass.com` consulta el snapshot del VPS cada cinco segundos.
El despachador de viajes programados corre dentro del API cada 15 segundos.
El endpoint `sendVpsPush` de Functions funciona como puente seguro hacia FCM;
el secreto compartido vive solo en los secretos del VPS y en la configuración
de Functions.

La keystore release histórica y una cuenta de servicio privada de Firebase no
están disponibles en este equipo; no se genera una clave sustituta ni se
publica un AAB que rompa las instalaciones existentes.

## Cliente Flutter opcional

Las apps incluyen el cliente VPS. Para compilar una APK que use el API:

```powershell
flutter build apk --debug --dart-define=VPS_API_BASE_URL=https://api.ejemplo.com
```

La variable se acepta en `passenger-app` y `driver-app`. La integracion cubre
inicio de sesion, viajes del pasajero, acciones del conductor, disponibilidad,
GPS y seguimiento de la posicion del conductor al pasajero. El tiempo real del
dashboard usa polling seguro y las notificaciones usan el puente FCM descrito
arriba.

No se debe usar `http://86.48.19.189` en una APK de produccion: el API actual
escucha solo en `127.0.0.1:8080`. Primero hay que publicar un dominio HTTPS
independiente del POS y probarlo con una APK de laboratorio.

### Proxy HTTPS habilitado

`api.tucomprass.com` termina en el Caddy existente, que conserva sus rutas del
POS y se conecta tambien a la red externa `apl-fleet-vps_default`. El bloque de
Caddy y el override de Compose usados para esa conexion estan en
`deploy/pos-caddy-fleet-api.caddyfile` y
`deploy/pos-caddy-fleet-api.override.yml`. El API interno sigue escuchando
solo en `127.0.0.1:8080`; no se publican PostgreSQL, Redis ni MinIO.
