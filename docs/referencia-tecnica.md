# Referencia técnica

## 1. Alcance

Esta referencia describe la implementación auditada. No sustituye un contrato de nivel de servicio ni una validación de producción. Los secretos y las credenciales se excluyen deliberadamente.

## 2. Arquitectura

```text
┌───────────────────┐       ┌────────────────────────────┐       ┌──────────────────┐
│ App de pasajeros  │──────▶│ Firebase Realtime Database │◀──────│ App de conductores│
│ Flutter           │       │ Authentication             │       │ Flutter           │
└─────────┬─────────┘       │ Storage + Cloud Messaging  │       └────────┬─────────┘
          │                 └──────────────┬─────────────┘                │
          │                                │                              │
          │                         ┌──────▼───────┐                      │
          └────────────────────────▶│ Cloud        │◀─────────────────────┘
                                    │ Functions    │
                                    └──────┬───────┘
                                           │
                                    ┌──────▼───────┐
                                    │ Dashboard web│
                                    │ Mapbox  │
                                    └──────────────┘
```

### Componentes del repositorio

| Carpeta | Responsabilidad |
|---|---|
| `passenger-app/` | App Flutter de pasajeros. |
| `driver-app/` | App Flutter de conductores y GPS en segundo plano. |
| `dashboard/` | Dashboard web estático con Firebase JS SDK y Mapbox GL JS. |
| `functions/` | Cloud Functions de asignación, ciclo de vida, notificaciones, administración y builds. |
| `database/` | Reglas de Realtime Database, reglas de Storage y esquema PostgreSQL alternativo. |
| `.github/workflows/` | Compilación automática de APK con nombre, icono y build configurables. |
| `scripts/` | Publicación del dashboard en un servidor estático. |

## 3. Stack y versiones observadas

- Flutter para las dos apps móviles.
- Firebase Realtime Database para datos operativos y estados.
- Firebase Authentication: correo/contraseña para conductores y dashboard; autenticación anónima para pasajeros.
- Firebase Storage para documentos, credenciales, branding y APK.
- Firebase Cloud Functions 1.ª generación con Node.js 22.
- Firebase Cloud Messaging para avisos.
- Mapbox Maps SDK para mapas móviles.
- Mapbox GL JS para el dashboard.
- Mapbox Geocoding API, Mapbox Directions API y Mapbox Matrix API; las rutas
  usan el perfil `driving` sin datos de tráfico.
- GitHub Actions para builds Android configurables.

## 4. Tiempos e indicadores operativos

| Indicador | Valor en código | Ubicación de referencia |
|---|---:|---|
| Envío GPS | Inmediato + cada 5 s | `driver-app/lib/config.dart`, `driver-app/lib/services/location_service.dart` |
| Timeout para obtener posición | 20 s | `driver-app/lib/services/location_service.dart` |
| Antigüedad máxima para asignación | 3 min | `functions/matching.js` |
| Estado atrasado del marcador | 45 s | `dashboard/js/app.js` |
| Retiro del marcador por falta de GPS | 3 min | `dashboard/js/app.js` |
| Refresco temporal del dashboard | 5 s | `dashboard/js/app.js` |
| Poll de asignación en app de conductor | 5 s | `driver-app/lib/main.dart` |
| Verificación de sesión del conductor | 20 s | `driver-app/lib/main.dart` |
| Poll buscando conductor | 3 s | `passenger-app/lib/screens/searching_screen.dart` |
| Poll del estado del viaje activo | 4 s | `passenger-app/lib/screens/active_trip_tracking_screen.dart` |
| Poll de posición del conductor | 5 s | `passenger-app/lib/screens/active_trip_tracking_screen.dart` |
| Poll de viaje programado | 15 s | `passenger-app/lib/main.dart` |
| Scheduler de viajes programados | 1 min | `functions/index.js` |
| Ventana de despacho programado | 10 min antes | `functions/index.js` |
| Umbral de cercanía para acciones | 100 m | `driver-app/lib/screens/active_trip_screen.dart` |
| Recalculo de ruta | Como máximo cada 30 s y al cambiar al menos 75 m o el objetivo | Apps y dashboard |

Los 5 segundos describen la generación y envío del dato desde el teléfono. No equivalen a una latencia garantizada de extremo a extremo.

## 5. Modelo de datos principal

### Conexiones y alertas de desconexion

- `drivers/{driverId}` mantiene `estado_conexion`, `ultima_conexion`, `ultimo_motivo_desconexion` y la posicion GPS (`lastUpdate`).
- `driverLocations/{driverId}` expone solamente latitud, longitud y `lastUpdate` para el seguimiento del pasajero.
- `prematureDisconnectAlerts/{alertId}` conserva el conductor, placa, hora exacta, motivo, estado de atención y última ubicación. Solo Cloud Functions puede escribirlo.
- La app envia GPS cada 5 segundos; el worker `detectPrematureDriverDisconnects` corre cada minuto y considera perdida de heartbeat despues de 30 segundos.

### Realtime Database

| Nodo | Contenido |
|---|---|
| `/config` | Soporte, branding, lugares, builds publicados y nombre/logo del dashboard. |
| `/drivers/{driverId}` | Perfil, vehículo, documentos, aprobación, posición, `lastUpdate`, disponibilidad, viaje activo y token FCM. |
| `/driverLocations/{driverId}` | Latitud, longitud y `lastUpdate` mínimos para la ubicación pública del viaje. |
| `/passengers/{passengerId}` | Nombre, teléfono, credencial, fecha de registro y token FCM. |
| `/trips/{tripId}` | Origen, destino, cantidad, estado, conductor asignado, timestamps y motivos. |
| `/tripHistory/{tripId}` | Copia archivada al completar o cancelar un viaje. |
| `/driverConnectionHistory/{driverId}` | Eventos de conexión y desconexión para asistencia. |
| `/driverUnique` | Reservas para evitar duplicar correo, teléfono, placa, DNI o nombre de conductor. |
| `/appBuildRequests/{requestId}` | Solicitudes temporales y de un solo uso para compilar branding. |

### Storage

- `driver_documents/{driverId}/`: documentos del conductor.
- `passenger_credentials/{passengerId}/`: foto de credencial del pasajero.
- `app_releases/`: APKs publicadas con nombre fijo.
- `app_branding/`: iconos configurables de las apps.
- `dashboard_branding/`: logo configurable del dashboard.

## 6. Estados del viaje

| Estado | Significado |
|---|---|
| `scheduled` | Viaje creado para una hora futura. |
| `searching` | Buscando conductor elegible. |
| `accepted` | Conductor asignado automáticamente; va al origen. |
| `arrived_at_pickup` | Conductor confirmó llegada al origen. |
| `in_progress` | Pasajero a bordo; se dirige al destino. |
| `completed` | Viaje finalizado; se libera el conductor y se archiva. |
| `cancelled` | Viaje cancelado; se libera el conductor y se archiva. |
| `no_drivers_available` | No se encontró conductor con condiciones válidas. |
| `assigned_pending_accept` y `rejected` | Estados reconocidos por reglas/interfaz histórica, no forman parte del flujo automático normal auditado. |

### Triggers de Cloud Functions

| Función | Tipo | Responsabilidad |
|---|---|---|
| `assignDriverOnTripCreate` | RTDB create | Asignar un conductor al crear un viaje en `searching`. |
| `dispatchScheduledTrips` | Scheduler cada minuto | Despachar viajes programados dentro de la ventana de 10 minutos. |
| `handleTripStatusChange` | RTDB update | Reintentar asignación, liberar conductor, archivar viaje y avisar llegada. |
| `recordDriverConnection` | RTDB write | Registrar conexiones y desconexiones. |
| `detectPrematureDriverDisconnects` | Scheduler cada minuto | Cerrar turnos sin heartbeat durante 30 segundos y crear alertas por pérdida de señal. |
| `notifyTripUpdated` | RTDB update | Avisar al conductor cuando cambia el destino. |
| `notifyApprovalStatusChange` | RTDB update | Avisar aprobación/rechazo y limpiar operación si corresponde. |

### Endpoints HTTP de Cloud Functions

| Endpoint | Uso | Control |
|---|---|---|
| `reserveDriverIdentity` | Validar unicidad del registro de conductor. | ID token válido. |
| `manageDrivers` | Asignar lugar, rechazar o eliminar conductor. | Usuario de dashboard; administración requiere claim de manager. |
| `setDriverAvailability` | Iniciar/terminar disponibilidad y registrar la desconexión. | ID token del conductor. |
| `manageOperationAlert` | Reconocer una alerta de desconexión. | Claim `dashboardAdmin`. |
| `updateDriverProfileOnce` | Actualizar teléfono validado de conductor aprobado. | ID token del conductor. |
| `initializeDashboardAdmin` | Inicializar/verificar claim del administrador. | Usuario de dashboard. |
| `manageDashboardUsers` | Listar, crear, actualizar roles o eliminar usuarios. | Claim `dashboardAdmin`. |
| `getMyTrips` | Obtener historial del pasajero autenticado. | ID token validado por backend. |
| `requestAppBrandingBuild` | Solicitar build de app con nombre/icono. | Usuario de dashboard. |
| `getAppBrandingBuild` | Entregar datos de una solicitud temporal. | Token de un solo uso. |
| `completeAppBrandingBuild` | Publicar un build después de subir la APK. | Token de un solo uso. |

## 7. Asignación y concurrencia

La asignación usa distancia Haversine, categorías de capacidad y una reclamación con ETag/`if-match` sobre Realtime Database. Si dos solicitudes compiten por el mismo vehículo, solamente la escritura que conserve el ETag puede reclamarlo. El patrón evita asignaciones dobles y también protege la transición de vuelta a `online`.

## 8. Integraciones externas

| Servicio | Uso | Fallback o limitación |
|---|---|---|
| Mapbox Maps SDK | Mapas en apps móviles. | Requiere token público separado por aplicación. |
| Mapbox GL JS | Mapa del dashboard. | Requiere token público restringido por dominio. |
| Mapbox Geocoding API | Autocompletado y detalle de lugares. | Requiere cuota y API habilitada. |
| Mapbox Geocoding API | Dirección de un pin seleccionado. | El usuario puede conservar coordenadas aunque falle la descripción. |
| Mapbox Directions API | Rutas y duración estimada. | Si falla, se dibuja una línea directa aproximada. |
| Firebase Cloud Messaging | Alertas con app minimizada/cerrada. | Polling de respaldo cuando el proceso está vivo. |
| GitHub Actions | Compilación de APK con branding. | Requiere secretos de keystore y configuración Firebase. |

## 9. Seguridad observada y acciones requeridas

- Las reglas validan campos conocidos y rechazan campos no definidos con `$other: false`.
- La aprobación de conductores y los roles del dashboard se controlan mediante Firebase Authentication y claims.
- Storage valida tamaño y tipo de documentos y separa la regla de `delete`.
- Los documentos contienen información personal y requieren acceso restringido.
- La configuración actual expone claves de proveedor en archivos del cliente. Aunque algunas claves de cliente son técnicamente públicas, deben rotarse y restringirse por dominio, paquete y API antes de la venta.
- `/drivers` requiere claims de dashboard; el conductor solo lee su propio perfil.
- `driverLocations/{driverId}` solo se entrega al conductor, a operadores autorizados o al pasajero asignado mientras el viaje está activo.
- Los coordinadores no tienen acceso a documentos de identidad ni credenciales almacenadas.
- El dashboard no debe publicarse por HTTP en producción; usar HTTPS, control de acceso y una política de respaldo.

## 10. Puntos de código para mantenimiento

- GPS y servicio de segundo plano: `driver-app/lib/services/location_service.dart`.
- Intervalos y estado de conductor: `driver-app/lib/main.dart`.
- Asignación: `functions/matching.js` y `functions/index.js`.
- Mapa y frescura visual: `dashboard/js/app.js`.
- Reglas: `database/firebase-rules.json` y `database/storage.rules`.
- Publicación dashboard: `scripts/publicar-dashboard.ps1`.
- Builds de apps: `.github/workflows/build-branded-app.yml`.
