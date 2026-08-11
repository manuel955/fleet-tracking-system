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

## Siguiente fase

Implementar autenticación, API de viajes, GPS, asignación, WebSocket y envío
FCM. Cada endpoint debe tener una prueba de contrato antes de cambiar una app
Flutter o el dashboard.
