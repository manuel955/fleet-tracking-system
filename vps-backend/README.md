# APL Logistics VPS backend

Esta carpeta inicia la migración gradual desde Firebase hacia Contabo. No
reemplaza todavía el backend de producción: las apps y el dashboard actuales
siguen usando Firebase hasta que los contratos de API y los datos se validen.

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

- `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `GET /api/v1/auth/me`.
- `GET /api/v1/drivers/me`, `POST /api/v1/drivers/availability` y
  `POST /api/v1/drivers/location` para conductores aprobados.
- `POST /api/v1/trips`, `GET /api/v1/trips`, `GET /api/v1/trips/:id`,
  `POST /api/v1/trips/:id/cancel` y `POST /api/v1/trips/:id/retry`.
- `GET /api/v1/trips/:id/driver-location` devuelve la ultima ubicacion del
  conductor solo al pasajero propietario de ese viaje.
- `POST /api/v1/trips/:id/action` para `arrive`, `start` y `complete`, y
  `POST /api/v1/trips/:id/feedback` para la calificación del pasajero.
- `POST /api/v1/device-tokens` registra el token del dispositivo; el envío
  push todavía se mantiene en Firebase hasta cerrar la migración FCM.

El despachador del backend revisa cada 15 segundos los viajes programados cuya
hora ya llegó y los pasa al emparejamiento transaccional. Si no hay un
conductor aprobado y disponible, el viaje queda en `no_drivers_available` y
puede reintentarse desde el endpoint de reintento.

## Siguiente fase

Implementar autenticación, API de viajes, GPS, asignación, WebSocket y envío
FCM. Cada endpoint debe tener una prueba de contrato antes de cambiar una app
Flutter o el dashboard.

## Cliente Flutter opcional

Las apps incluyen un cliente VPS gradual, pero Firebase sigue siendo el valor
predeterminado. Para compilar una APK de laboratorio que use el API:

```powershell
flutter build apk --debug --dart-define=VPS_API_BASE_URL=https://api.ejemplo.com
```

La variable se acepta en `passenger-app` y `driver-app`. La integracion actual
cubre inicio de sesion, viajes del pasajero, acciones del conductor,
disponibilidad y GPS. El seguimiento de la posicion del conductor al pasajero,
WebSocket, FCM nativo del VPS y el alta completa de conductores siguen
pendientes de contrato antes de activar esta bandera para usuarios reales.

No se debe usar `http://86.48.19.189` en una APK de produccion: el API actual
escucha solo en `127.0.0.1:8080`. Primero hay que publicar un dominio HTTPS
independiente del POS y probarlo con una APK de laboratorio.
