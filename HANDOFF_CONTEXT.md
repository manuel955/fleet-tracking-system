# Contexto de traspaso (Claude Code → ChatGPT/Codex CLI)

Este archivo complementa `README.md` (que cubre arquitectura y puesta en marcha
"en estado estable"). Aquí va lo que README **no** tiene todavía: decisiones y
cambios de las últimas sesiones, detalles de entorno de esta máquina, y
pendientes. Léelo primero al retomar el proyecto con otra herramienta.

## Estado general

Sistema de rastreo de flota + viajes tipo Uber para Renzo (empresa de
transporte para organizaciones, **sin cobro por viaje**), en producción y
funcionando de punta a punta. Firebase project `rastreoflota-53052` (plan
Blaze). Esta carpeta **no era un repo git** hasta este traspaso — se
inicializó git ahora mismo (ver abajo) para tener un punto de partida limpio.

## Cambios recientes que README aún no documenta (2026-07-22/23)

**1. Cancelación de viaje restringida a admin/dashboard, una vez asignado el conductor.**
- Regla en `database/firebase-rules.json` (`/trips/$tripId` `.write`), ya
  desplegada: el pasajero solo puede escribir `status:'cancelled'` mientras el
  viaje todavía no tiene `driverId`; el conductor nunca puede cancelar; una
  cuenta `sign_in_provider === 'password'` (dashboard) siempre puede.
- `passenger-app`: botón "Cancelar viaje" se quitó de
  `active_trip_tracking_screen.dart` (pantalla post-asignación). Sigue
  existiendo en `searching_screen.dart` (antes de que haya conductor).
- `driver-app`: nunca tuvo botón de cancelar.
- `dashboard/js/app.js`: nuevo botón "Cancelar viaje" en la tarjeta del
  conductor con viaje activo (`cancelTrip()`, `confirm()`,
  `cancelledBy:'admin'`). Estilo en `dashboard/css/style.css`
  (`.cancel-trip-btn`).

**2. Bug corregido: conductor quedaba "libre" en el dashboard con un viaje en curso** si cerraba la app a mitad de viaje.
- Causa: `driver-app/lib/main.dart` `_startShift()` ponía `status:'online'`
  en cada arranque/reapertura sin revisar `currentTripId`.
- Fix definitivo en `driver-app/lib/services/trip_service.dart`:
  `TripService.setAvailability(online:true)` ahora usa el mismo patrón
  ETag/`if-match` que Cloud Functions (`claimDriver`/`releaseDriver` en
  `functions/matching.js`) — GET con `X-Firebase-ETag:true`, aborta si
  `currentTripId` no es null, PUT con `if-match` (412 = perdió la carrera).
  `online:false` sigue siendo PATCH simple (esos flujos ya bloquean si hay
  viaje activo).
- Consecuencia: en `dashboard/js/app.js` se corrigieron 3 lugares que
  confiaban en `d.status==='busy'` en vez de `d.currentTripId` para saber si
  un conductor tiene viaje activo: `driverState()`, `syncActiveTripListeners()`,
  `refreshRouteForSelected()`.

**3. Dashboard: nuevo marcador de punto de recogida/destino.**
- Antes el mapa del dashboard solo dibujaba el auto del conductor. Se agregó
  `targetMarker` en `drawRoute()`: pin azul mientras va a recoger, pin morado
  una vez el pasajero está a bordo. Se limpia en `clearRoute()`.

**4. Rediseño visual estilo Uber (negro/blanco) en las 3 superficies.**
Paleta compartida — usarla en cualquier cambio visual nuevo:
- Base: negro `#000000` / blanco `#FFFFFF`.
- Verde (disponible/éxito/llamar): `#06C167`
- Naranja (en ruta de recogida): `#FF9500`
- Azul (en viaje/navegación): `#276EF1`
- Rojo (cancelar/rechazar/error): `#E11900` (dashboard; Flutter sigue con
  `Colors.red.shade600/700`, no migrado a hex exacto).
- Gris neutro (desconectado): `#9CA3AF`
- Ruta en el mapa: negro, no azul (dashboard, driver-app, passenger-app).

Aplicado en: `dashboard/css/style.css` (rediseño completo — antes azul
Bootstrap-like), `dashboard/js/app.js` (`STATE_COLORS`, color del polyline),
`driver-app/lib/screens/active_trip_screen.dart`,
`passenger-app/lib/screens/active_trip_tracking_screen.dart`, y
`inputDecorationTheme` global + pantallas de login/registro pulidas en ambas
apps Flutter. Revisión completa de pantallas ya hecha — no queda ninguna sin
revisar salvo verificación visual final de Renzo.

**Diagnóstico importante para pruebas:** solo hay UN conductor registrado en
el sistema de pruebas (`FECwge1UBISYU0ipoyLHXSE4IJh2`, teléfono Samsung). Si
su app está cerrada/offline o su GPS tiene más de 3 min de antigüedad
(`STALE_LOCATION_MS` en `matching.js`) en el instante en que el pasajero pide
un viaje, `assignDriverOnTripCreate` no encuentra candidatos y el viaje queda
`no_drivers_available` sin error. Confirmado como causa real de un caso de
"el viaje no llega al conductor" — no era bug de código. Revisar esto antes
de asumir un bug cuando un pedido no se asigna.

## Pendiente / no confirmado

- Migrar Cloud Functions de Node 20 a Node 22 antes del **2026-10-30**
  (deprecación de Node 20 en Cloud Functions 1a gen).
- Dashboard no está desplegado a Firebase Hosting — sigue como archivo
  estático local, servido para pruebas con un mini servidor node (ver abajo).
- Renzo aún no dio visto bueno visual final del rediseño Uber (revisó las
  apps recién instaladas, sin feedback explícito todavía).
- README raíz puede seguir sin cobertura completa de los cambios de
  cancelación/dashboard/paleta listados arriba — actualízalo si haces más
  cambios en esas áreas.
- Regla de seguridad pendiente señalada en README: cualquier usuario
  autenticado puede leer `/drivers` — falta restringir con custom claims de
  admin antes de exponer datos reales.

## Bug/patrón a recordar: nunca usar `ref.transaction()` contra RTDB desde Cloud Functions

Se probó y no es confiable dentro de Cloud Functions (el callback siempre
recibía `null`). El patrón que sí funciona, usado en `functions/matching.js`
y ahora también en `driver-app/lib/services/trip_service.dart`, es REST +
concurrencia optimista: GET con header `X-Firebase-ETag: true`, verificar el
estado antes de escribir, PUT con header `if-match: <etag>` (un 412 significa
que otro proceso ganó la carrera, se ignora/reintenta). Si agregas más
escrituras condicionales de servidor o cliente, replica este patrón.

## Entorno de esta máquina (Windows, para quien siga en esta misma PC)

- Firebase login (consola/CLI): `anfurex.3351@gmail.com`. El CLI de
  firebase-tools ya tiene sesión guardada localmente.
- gsutil/gcloud NO están instalados — usar la Storage JSON API con el
  access_token de firebase-tools si hace falta tocar CORS del bucket.
- PATH relevante: Flutter en
  `C:\src\flutter\flutter_windows_3.44.6-stable\flutter\bin`, adb en
  `%LOCALAPPDATA%\Android\Sdk\platform-tools`, node en
  `C:\Program Files\nodejs`, firebase CLI en `%APPDATA%\npm`.
- En Git Bash, anteponer `MSYS_NO_PATHCONV=1` a comandos
  `firebase database:get/update/remove /path` (si no, bash convierte
  `/drivers` en una ruta de filesystem de Windows).
- `firebase database:get <path> -o <archivo>` para volcar datos y parsear —
  usar un archivo real, no `/dev/stdout` (el CLI mezcla su propio texto con
  el JSON).
- Cloud Functions base URL:
  `https://us-central1-rastreoflota-53052.cloudfunctions.net`. Logs:
  `firebase functions:log --project rastreoflota-53052 -n N` (timestamps en
  UTC; Perú es UTC-5).
- Teléfonos de prueba: Samsung = conductor (serial `R5CY72078ZM`), Huawei P30
  Pro = pasajero (serial `45C7N19420000522`). El Samsung frecuentemente NO
  aparece en `adb devices` aunque esté conectado (interfaz ADB en estado
  "Unknown" en el Administrador de dispositivos) — pedirle a Renzo
  desconectar/reconectar el cable o cambiar el modo USB a MTP;
  `adb kill-server && adb start-server` no lo arregla solo.
- Para probar cambios de Dart en dispositivo:
  `flutter build apk --release` (dentro de `driver-app/` o `passenger-app/`)
  + `adb -s <serial> install -r <ruta.apk>`. El dashboard (JS/CSS/HTML puro)
  no necesita build, solo recargar la página.
- Dashboard local para pruebas: mini servidor node en
  `.claude/launch.json` (carpeta `../.claude` relativa a este repo), puerto
  8877, sirve `fleet-tracking-system/dashboard`. Si esa herramienta no está
  disponible en el nuevo entorno, se puede levantar equivalente con
  `npx serve fleet-tracking-system/dashboard` o cualquier servidor estático.
- Dependencia con fricción conocida (driver-app): `file_picker: ^9.0.2` (no
  11.x) + `dependency_overrides: flutter_plugin_android_lifecycle: 2.0.24`
  en `pubspec.yaml` — evita reintroducir el conflicto de Kotlin Gradle Plugin
  si actualizas dependencias.

## Cómo retomar esto en Codex CLI

1. Instala Codex CLI si no lo tienes (`npm i -g @openai/codex`, o revisa la
   guía oficial de OpenAI vigente al momento de leer esto).
2. Abre una terminal en esta carpeta:
   ```bash
   cd "C:\Users\Manuel\Desktop\uber 3.0\fleet-tracking-system"
   codex
   ```
3. Como primer mensaje, pídele que lea `HANDOFF_CONTEXT.md` y `README.md`
   antes de tocar nada, por ejemplo:
   > Lee HANDOFF_CONTEXT.md y README.md en esta carpeta antes de hacer
   > cualquier cambio. Dame un resumen de en qué quedó el proyecto y qué
   > está pendiente.
4. El repo ya tiene git inicializado con un commit inicial (ver más abajo) —
   así Codex puede ver diffs y tú puedes revertir cambios que no te gusten
   con `git diff` / `git checkout` normales.
5. Ten a mano las credenciales que uses tú directamente (no las comparto en
   texto plano en ningún archivo del repo): login de Firebase, la Maps API
   key (está en `dashboard/js/google-maps-config.js` y en el
   `AndroidManifest.xml` de cada app Flutter — ya están en el código, Codex
   las va a poder leer igual que yo).
