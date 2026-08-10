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
└── dashboard/         # Panel web para administracion: flota en vivo sobre Mapbox
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
- El historial envía el ID token en el encabezado `Authorization`, nunca en la
  URL. Los viajes finalizados admiten calificación e incidencias; el dashboard
  permite marcar cada incidencia como abierta o resuelta.

## Detalles clave por componente

### functions/
- `matching.js` reclama/libera conductores con la API REST de Firebase y
  concurrencia optimista (`X-Firebase-ETag` / `if-match`), **no** con
  `ref.transaction()` — ese metodo demostro no ser confiable dentro de Cloud
  Functions (el callback siempre recibia `null`). Si agregas mas escrituras
  condicionales de servidor, replica el patron ETag.
- Las políticas de turno/GPS y ciclo de viaje viven en módulos puros usados
  por los handlers. Ejecuta `npm test`, `npm run test:coverage` y
  `npm run test:rules` dentro de `functions/`; el último comando valida las
  reglas reales de Realtime Database y Storage contra los emuladores.
- Al asignar, envia un push FCM **solo-datos** (prioridad alta) al
  `fcmToken` del conductor: sin bloque `notification`, para que el handler
  de background de la app corra siempre y reproduzca la alerta completa
  (canal con sonido/vibracion + voz TTS) aunque la app este cerrada.
- Runtime Node.js 22 (1a gen), configurado en `functions/package.json`.

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
- Navegacion externa mediante el esquema `geo:` del telefono. Voz TTS en espanol con tono
  agudo (los motores TTS no siempre exponen genero de voz).

### passenger-app/
- El acceso se activa con una invitación QR temporal del hotel. El código
  puede limitar usos y vencimiento; revocarlo invalida también los accesos ya
  canjeados. Las cuentas antiguas se migran una sola vez.
- La cuenta inicia de forma anónima para canjear el QR y puede vincular correo
  y contraseña para recuperación. No se usa SMS.
- Estilo Uber en blanco/negro, 3 pestañas: Inicio (mapa + "¿A donde
  vas?"), Actividad (viajes de los ultimos 7 dias), Cuenta.
- Destino por busqueda (Mapbox Geocoding), recientes, o pin fijo al centro
  del mapa arrastrable ("Fija tu destino") con geocoding inverso.
- La ruta usa **Mapbox Directions API** con perfil `driving`; si la
  red o el token fallan, la pantalla dibuja una linea recta de respaldo.
- Al completar o cancelar, **Actividad** permite calificar o reportar una
  incidencia. El acceso vencido bloquea nuevos viajes sin ocultar uno abierto.
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
   firebase deploy --only database,storage,functions
   ```
   En Windows, si el primer análisis de Functions vence durante un arranque
   en frío, repite con `$env:FUNCTIONS_DISCOVERY_TIMEOUT='30'`; este ajuste
   amplía solo el tiempo de descubrimiento del CLI y no cambia el runtime.
2. **Mapbox**: crea tokens publicos separados para dashboard, conductor y
   pasajero. El uso requiere acceso a Maps SDK, Directions API, Matrix API y
   Geocoding API. Las rutas y ETA usan el perfil `driving`, sin datos de
   tráfico ni capa visual de congestión.
3. **Apps Flutter** (`driver-app/` y `passenger-app/`):
   - `lib/config.dart`: API key de Firebase, Database URL y (passenger)
     base URL de Cloud Functions.
   - Inyecta el token sin guardarlo en el codigo:
     `flutter build apk --release --dart-define=MAPBOX_ACCESS_TOKEN=pk....`.
   - Opcionalmente define `MAPBOX_STYLE_URI`; el valor por defecto es el estilo
     Standard de Mapbox.
   - driver-app ademas necesita `android/app/google-services.json` (app
     Android registrada en Firebase, para FCM).
   - Compila e instala en telefono fisico (GPS/camara reales). Siempre pasa
     el token; si no, la app muestra el estado seguro de mapa no configurado:
     ```bash
     flutter pub get
     flutter build apk --release --dart-define=MAPBOX_ACCESS_TOKEN=pk....
      ```
   - Los workflows de GitHub generan APK/AAB con la keystore fija guardada en
     secretos. Un build release local falla si no se definen las variables
     `FLEET_KEYSTORE_*`; nunca usa una llave debug como respaldo.
4. **Dashboard**: configura `dashboard/js/firebase-config.js`; genera el
   runtime de Mapbox desde la raiz con `node scripts/inject-mapbox-config.mjs`
   usando `MAPBOX_ACCESS_TOKEN` y `MAPBOX_STYLE_URI`. Puede publicarse en el
   target Firebase Hosting `dashboard` con `scripts/publicar-dashboard-firebase.ps1`
   o en el VPS mediante el flujo descrito abajo. Entra con un usuario de
   Email/Password que tenga los custom claims del dashboard.
5. **Web de pasajeros**: Firebase Hosting sirve `passenger-app/build/web`.
    Debes compilarlo con el token real de Mapbox antes de desplegarlo:
    ```powershell
    cd passenger-app
    flutter build web --release --dart-define=MAPBOX_ACCESS_TOKEN=$env:MAPBOX_ACCESS_TOKEN
    cd ..
    firebase deploy --only hosting
    ```
    El build web nuevo usa Mapbox GL JS; una APK o build web antiguo seguirá
    mostrando el proveedor anterior hasta que se reinstale o se publique el
    build actualizado.
    Para compilar y publicar en un solo paso, usa desde la raiz:
    `powershell -ExecutionPolicy Bypass -File .\scripts\publicar-passenger-web.ps1`.

### Publicar el dashboard en el VPS

El dashboard se publica en el Caddy que ya forma parte del stack del VPS.
Despues de modificar cualquier archivo dentro de `dashboard/`, ejecuta desde
la raiz del repositorio:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\publicar-dashboard.ps1 `
  -Dominio apl.tucomprass.com
```

El script solo reinicia el contenedor Caddy para añadir la ruta del dashboard;
no reinicia backend, frontend ni base de datos de Sistema POS. Guarda respaldos
del `Caddyfile` y del override antes de actualizar la ruta.

Antes de ejecutarlo, crea en el proveedor DNS un registro `A` para
`apl.tucomprass.com` apuntando a `86.48.19.189`. Caddy emitira el certificado
HTTPS automaticamente cuando el registro ya se haya propagado.

## Notas de seguridad para produccion

- `/drivers` y los datos administrativos requieren custom claims del dashboard.
  La app de pasajeros solo puede leer `driverLocations/{driverId}` mientras
  ese conductor está asignado a uno de sus viajes activos.
- Los coordinadores no pueden leer perfiles completos ni documentos de
  conductores/pasajeros; su acceso se limita al flujo de despacho de su sede.
- Usa tokens publicos `pk.*` con restricciones de URL/origen para el dashboard
  y tokens separados por app. Nunca pongas un token secreto `sk.*` en cliente.
- Sirve el dashboard solo detras de HTTPS y acceso controlado (expone
  telefonos de conductores).
- Firebase Hosting y el flujo Caddy publican CSP, HSTS, restricción de marcos,
  política de permisos y SRI para las dependencias JavaScript externas.

## Documentacion para entrega y venta

La documentación completa de la solución está en [`docs/`](docs/README.md): incluye dossier comercial, manual de operación, referencia técnica y guía de despliegue y transferencia.
