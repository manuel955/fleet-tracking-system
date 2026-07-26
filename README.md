# Sistema de flota con viajes tipo Uber

Rastreo de vehiculos en tiempo real + solicitud de viajes para una empresa
de transporte que atiende organizaciones (sin cobro por viaje). Cinco
componentes sobre Firebase (proyecto Blaze):

```
fleet-tracking-system/
├── database/          # Reglas Firebase RTDB y Storage (+ esquema Postgres alternativo, no usado)
├── functions/         # Cloud Functions: emparejamiento automatico, ciclo de vida del viaje, historial
├── driver-app/        # Flutter: registro con documentos + aprobacion admin, GPS en segundo plano, viajes
├── passenger-app/     # Flutter: pedir viaje estilo Uber (mapa, destino, seguimiento, historial)
└── dashboard/         # Panel web para administracion: flota en vivo sobre Google Maps
```

## Flujo de un viaje

```
[passenger-app]                [Firebase RTDB + Cloud Functions]                 [driver-app]
Pide viaje ──POST /trips──▶ trips/{id} status:'searching'
                             └─ assignDriverOnTripCreate:
                                busca conductores status:'online' con GPS
                                fresco (<3 min), elige el mas cercano y lo
                                reclama de forma atomica (REST + ETag)      ──▶ Push FCM (solo-datos) +
                                status pasa directo a 'accepted' — el           polling cada 5s: alerta con
                                conductor NO acepta/rechaza ni puede            sonido, vibracion y voz
                                cancelar                                        "Nuevo Servicio Asignado"
Ve placa/nombre/telefono ◀── trips/{id} driverId, driverName, ...
del conductor asignado
                                                                            ◀── Avanza el viaje: 'arrived_at_pickup'
                                                                                → 'in_progress' → 'completed'
                             └─ handleTripStatusChange: al llegar a
                                'completed'/'cancelled' libera al conductor
                                (vuelve a 'online', tambien con ETag)
```

- Si no hay conductores disponibles el viaje queda en `no_drivers_available`
  y el pasajero puede reintentar (vuelve a `searching` y se re-ejecuta el
  emparejamiento).
- El pasajero puede cancelar; el conductor no.
- `getMyTrips` (HTTP) devuelve el historial del pasajero: las reglas de RTDB
  son por-registro y no permiten queries `orderBy/equalTo` del cliente sobre
  `/trips`, asi que ese listado lo hace el Admin SDK verificando el idToken.

## Detalles clave por componente

### functions/
- `matching.js` reclama/libera conductores con la API REST de Firebase y
  concurrencia optimista (`X-Firebase-ETag` / `if-match`), **no** con
  `ref.transaction()` — ese metodo demostro no ser confiable dentro de Cloud
  Functions (el callback siempre recibia `null`). Si agregas mas escrituras
  condicionales de servidor, replica el patron ETag.
- Al asignar, envia un push FCM **solo-datos** (prioridad alta) al
  `fcmToken` del conductor: sin bloque `notification`, para que el handler
  de background de la app corra siempre y reproduzca la alerta completa
  (canal con sonido/vibracion + voz TTS) aunque la app este cerrada.
- Runtime Node.js 20 (1a gen). **Deprecado: migrar a Node 22 antes del
  2026-10-30** o los deploys dejaran de funcionar.

### driver-app/
- Cuenta con correo/contraseña (Firebase Auth, sesion persistente entre
  aperturas). El registro pide nombre, edad, telefono, DNI, placa y 8
  documentos (foto de perfil, DNI, licencia, SOAT, tarjeta unica de
  circulacion, revision tecnica vehicular, record y certificado unico
  laboral, cada uno como foto o PDF) que se suben a Storage
  (`driver_documents/{uid}/...`). El conductor queda en `pending_review`
  hasta que un admin lo aprueba o rechaza (con motivo) desde el dashboard;
  las reglas de RTDB bloquean que `status` pase a `'online'` si no esta
  `approved`. Al quedar aprobado, el rastreo GPS arranca solo (servicio en
  primer plano) y queda `online`. Termina con "Terminar turno" (ya no
  cierra la sesion).
- Aviso de viaje nuevo por dos vias que se complementan: push FCM
  (funciona con la app minimizada o cerrada) y polling de `currentTripId`
  cada 5s (cubre la app abierta; con la app visible el push solo adelanta
  el poll, la alerta se deduplica por tripId).
- El canal de notificacion es `trip_alert_channel_v2`: Android congela la
  config de vibracion de un canal al crearlo — si cambias el patron,
  renombra el canal.
- Navegacion solo con Google Maps (sin Waze). Voz TTS en espanol con tono
  agudo (los motores TTS no siempre exponen genero de voz).

### passenger-app/
- Estilo Uber en blanco/negro, 3 pestañas: Inicio (mapa + "¿A donde
  vas?"), Actividad (viajes de los ultimos 7 dias), Cuenta.
- Destino por busqueda (Places API New), recientes, o pin fijo al centro
  del mapa arrastrable ("Fija tu destino") con geocoding inverso.
- La ruta de confirmacion usa **Routes API v2** (la Directions API clasica
  esta bloqueada en el proyecto); polyline decodificada con fallback a
  linea recta.
- Cerrar sesion borra viajes, perfil y foto credencial en Firebase y todo
  lo local.

### database/
- `firebase-rules.json`: cada conductor/pasajero solo escribe su propio
  nodo; los viajes solo los leen su pasajero y su conductor; campos
  desconocidos rechazados (`$other: false`) — si agregas un campo nuevo
  (ej. `fcmToken`), agregalo tambien a las reglas o la escritura fallara.
- `storage.rules` valida tamaño/tipo en `write`, y por eso `delete` se
  permite por separado (en RTDB/Storage `write` no cubre deletes cuando
  hay esas validaciones).
- `postgres-schema.sql` es un diseño alternativo no usado (ver
  `database/README.md`).

## Puesta en marcha

Requisitos: Flutter SDK, Firebase CLI (`npm i -g firebase-tools`), un
proyecto Firebase Blaze con Realtime Database, Authentication (Anonymous
para passenger-app + Email/Password para el dashboard y driver-app),
Storage y Cloud Messaging.

1. **Reglas y funciones**
   ```bash
   cd fleet-tracking-system
   firebase deploy --only database,functions
   ```
2. **Google Maps Platform**: habilita Maps SDK for Android, Maps JavaScript
   API, Places API (New), Geocoding API y **Routes API**. Si la key tiene
   restriccion por API, incluye todas las anteriores.
3. **Apps Flutter** (`driver-app/` y `passenger-app/`):
   - `lib/config.dart`: API key de Firebase, Database URL y (passenger)
     base URL de Cloud Functions.
   - API key de Maps en `android/app/src/main/AndroidManifest.xml`.
   - driver-app ademas necesita `android/app/google-services.json` (app
     Android registrada en Firebase, para FCM).
   - Compila e instala en telefono fisico (GPS/camera reales):
     ```bash
     flutter pub get
     flutter build apk --release
     ```
   - Los builds release firman con la llave debug (ver TODO en
     `build.gradle.kts`); genera una keystore propia antes de distribuir.
4. **Dashboard**: configura `dashboard/js/firebase-config.js` y
   `dashboard/js/google-maps-config.js`, sirve la carpeta como sitio
   estatico y entra con el usuario admin de Email/Password.

### Publicar el dashboard en el VPS

En esta maquina, despues de modificar cualquier archivo dentro de
`dashboard/`, ejecuta desde la raiz del repositorio:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\publicar-dashboard.ps1
```

El script publica solamente el dashboard en `http://86.48.19.189/flota/`,
sin reiniciar los contenedores ni modificar los servicios de Sistema POS.
Tambien puedes hacer doble clic en `scripts/publicar-dashboard.cmd`.

## Notas de seguridad para produccion

- Cualquier usuario autenticado (incluso anonimo) puede leer `/drivers`;
  restringe la lectura con custom claims de admin antes de exponer datos
  reales.
- Restringe la API key de Google Maps por paquete/dominio.
- Sirve el dashboard solo detras de HTTPS y acceso controlado (expone
  telefonos de conductores).
