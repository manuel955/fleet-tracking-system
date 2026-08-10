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

## Estado de entrega al 2026-08-09

- Cloud Functions usa Node 22. El 2026-08-09 se desplegaron correctamente
  todas las Functions junto con las reglas defensivas de Realtime Database y
  Storage en `rastreoflota-53052`.
- El dashboard está publicado por HTTPS en Firebase Hosting, target
  `rastreoflota-53052-dashboard`, y fue verificado después del despliegue del
  2026-08-09 en `https://rastreoflota-53052-dashboard.web.app`. También se
  conserva el flujo alternativo al VPS.
- Renzo aún no dio visto bueno visual final del rediseño Uber (revisó las
  apps recién instaladas, sin feedback explícito todavía).
- La rama `codex/build-driver-aab` se fusionó mediante la PR #2 en `master`
  (`d0af34d`) y la rama remota fue eliminada.
- La validación previa al despliegue quedó verde: 53 pruebas de Functions,
  15 casos de reglas en emuladores, 8 del dashboard, 4 del conductor y 2 del
  pasajero. Los módulos críticos medidos alcanzaron 71.64% de líneas.
- `.github/workflows/ci.yml` repite esta validación automáticamente en cada PR
  y cada push a `master`, sin usar credenciales de producción.
- Lo único no cerrable desde el repositorio es la aceptación visual final de
  Renzo y la rotación/restricción de claves del proyecto, que debe hacer el
  propietario desde Firebase/Google Cloud/Mapbox sin compartir secretos en el
  código ni en el chat.

## Fase 7 local pendiente de desplegar (2026-08-09)

El árbol de trabajo contiene un grupo amplio de correcciones aún no confirmado
ni desplegado como una sola entrega. No hacer `git reset --hard` ni reemplazar
estos archivos sin revisar el diff. Entre los cambios ya validados localmente:

- Se eliminó el flujo Phone/SMS del pasajero y se añadió recuperación por
  correo/contraseña, con migración de la cuenta existente y sesión cifrada.
- Los QR de hotel tienen vigencia y revocación real; revocar una invitación
  invalida también los accesos ya canjeados. Un acceso vencido no se reactiva
  por la migración heredada.
- La creación de viajes del pasajero es idempotente, limita viajes simultáneos,
  recupera respuestas perdidas y conserva viajes abiertos sin conexión.
- El registro de conductor exige todos los documentos, sus vigencias y permite
  reenviar únicamente los grupos rechazados. Suspensión, aprobación y
  cancelación administrativa pasan por Functions y quedan auditadas.
- Las sesiones móviles usan almacenamiento seguro; las llamadas de red tienen
  timeout; la ubicación vieja del conductor no se presenta como actual.
- El historial ya no coloca tokens en la URL. El pasajero puede calificar o
  reportar una incidencia y el dashboard puede resolverla o reabrirla.
- Dashboard con métricas diarias corregidas, navegación según rol, recuperación
  de contraseña, CSP/HSTS/Permissions-Policy y SRI en dependencias externas.
- Versiones actuales del código: conductor `1.0.1+54`, pasajero `1.0.0+43`.
  Los números de build se reservan/publican de forma monotónica.
- Última validación de este grupo: 103/103 pruebas de Functions y reglas con
  emuladores RTDB/Storage, 8/8 de dashboard, 9/9 de pasajero y 7/7 de
  conductor; ambos análisis Flutter quedaron limpios. Los APK debug de ambas
  apps compilaron. No son artefactos de entrega porque no contienen el token
  Mapbox ni la firma release.

Pendientes que requieren decisión o acción del propietario:

1. La keystore histórica de las instalaciones existentes ya fue identificada y
   verificada contra el AAB firmado anterior: certificado SHA-256
   `F4E1988474EEDE90D6AE1423BE31C9D4A7760F80D991BE94551E14287C52C4B5`.
   La huella pública ya está guardada en GitHub como
   `ANDROID_RELEASE_CERT_SHA256`; se conserva `ANDROID_DEBUG_KEYSTORE_BASE64`
   como nombre heredado para no romper actualizaciones. No se generó una llave
   nueva ni se expuso la clave privada. El workflow corregido (memoria Gradle
   limitada, cache y log directo) terminó correctamente en GitHub Actions:
   run `31348062790`, build `56`, artefacto
   `apl-conductores-v1.0.1-56-signed`; la huella del AAB coincide con la
   configurada. El artefacto está disponible en GitHub Actions y no se publicó
   automáticamente en Play Store.
2. Restringir y rotar los tokens públicos de Mapbox y las claves de Firebase.
3. Ejecutar la auditoría visual con capturas cuando el árbol Git esté limpio;
   la guía usada requiere commits atómicos y no debe aplicarse sobre este diff.
4. Compilar, instalar y probar APK/AAB release en teléfonos físicos antes de
   publicar los builds nuevos.
5. Decidir y ejecutar una migración de documentos privados fuera del nodo
   operativo `/drivers`: hoy los perfiles heredados guardan URLs firmadas de
   Storage dentro de ese nodo. Cambiarlo exige separar datos privados y migrar
   registros existentes; no se hizo silenciosamente porque es un cambio de
   arquitectura y datos en producción.
6. Ejecutar el despliegue coordinado de Functions, reglas, dashboard y apps.
   Ninguno de los cambios locales de fase 7 está publicado todavía.

La compilación con Flutter 3.44.6 también avisa que `flutter_tts`,
`mapbox_maps_flutter` y `mobile_scanner` aún aplican el Kotlin Gradle Plugin
tradicional. Compilan actualmente, pero sus próximas versiones deben revisarse
antes de una futura actualización mayor de Flutter.

La auditoría de dependencias de Functions (`npm audit --omit=dev
--audit-level=high`) no reporta vulnerabilidades. `flutter pub outdated` sí
identifica actualizaciones disponibles, incluidas versiones mayores de
Mapbox, geolocalización, permisos, almacenamiento seguro y notificaciones;
quedan para una tarea separada porque requieren regresión en Android físico.

## Patrón de concurrencia para estados críticos

Para transiciones críticas de viaje, ubicación, cancelación e incidencias se
usa REST con concurrencia optimista: GET con header
`X-Firebase-ETag: true`, verificación del estado y PUT con
`if-match: <etag>`. Un 412 significa que otro proceso ganó la carrera y debe
reintentarse o mostrarse como conflicto. El proyecto conserva transacciones
acotadas en reservas/idempotencia ya cubiertas por pruebas; no introducir una
nueva escritura condicional sin elegir y probar explícitamente su estrategia
de concurrencia.

## Entorno de esta máquina (Windows, para quien siga en esta misma PC)

- El CLI de firebase-tools ya tiene una sesión local. No documentar el correo
  de la cuenta propietaria ni copiar sus credenciales al repositorio.
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
- Teléfonos de prueba: un Samsung para conductor y un Huawei P30 Pro para
  pasajero. No guardar los seriales en documentación versionada. El Samsung
  frecuentemente no aparece en `adb devices` aunque esté conectado (interfaz
  ADB en estado "Unknown" en el Administrador de dispositivos):
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
5. Ten a mano las credenciales que uses tu directamente (no las compartas en texto plano en ningun archivo del repo): login de Firebase y tokens publicos de Mapbox. Se inyectan al compilar las apps con `--dart-define=MAPBOX_ACCESS_TOKEN=...` y en el dashboard con `scripts/inject-mapbox-config.mjs`.
