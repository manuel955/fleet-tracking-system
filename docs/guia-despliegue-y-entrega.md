# Guía de despliegue y entrega

## 1. Objetivo

Esta guía permite que un equipo técnico instale la solución en un proyecto del cliente y entregue una operación reproducible. No contiene credenciales reales. Sustituye los marcadores por valores del cliente usando un gestor de secretos.

## 2. Requisitos

### Servicios

- Proyecto Firebase en plan Blaze.
- Realtime Database.
- Authentication con Anonymous y Email/Password. El proveedor Phone/SMS no es necesario.
- Firebase Storage.
- Cloud Functions.
- Firebase Cloud Messaging.
- Mapbox Maps SDK para Android, Mapbox GL JS, Geocoding API, Directions API y
  Matrix API. Las rutas usan `driving`, sin datos de tráfico.
- Repositorio GitHub con Actions habilitado si se usará branding/build automático.
- Servidor HTTPS para el dashboard o plataforma equivalente.

### Herramientas

- Flutter SDK estable compatible con los `pubspec.yaml`.
- Node.js y npm para Firebase CLI y dependencias de Functions.
- Firebase CLI autenticado con el proyecto del cliente.
- Android SDK y herramienta de firma de producción.
- Teléfonos físicos para validar GPS, cámara, notificaciones y permisos.

## 3. Matriz de configuración segura

| Elemento | Dónde se configura | Entrega recomendada |
|---|---|---|
| ID y URL de Firebase | Configuración de cada app y dashboard | Sustituir por el proyecto del cliente. |
| Firebase Android config | `google-services.json` | No subir al repositorio público; entregar por canal seguro. |
| Token Mapbox movil | `--dart-define=MAPBOX_ACCESS_TOKEN=pk....` | Token publico separado por app. |
| Token Mapbox web | `dashboard/js/mapbox-runtime-config.generated.js` | Generarlo desde variables de entorno; nunca versionar el token. |
| Keystore Android | GitHub Actions/entorno de firma | Custodia exclusiva del propietario; no usar llave de desarrollo. |
| Token GitHub Actions | Secret `GITHUB_DISPATCH_TOKEN` | Secret del repositorio/organización del cliente. |
| Teléfono de soporte | `/config/supportPhone` | Configurable desde el dashboard. |
| Builds publicados | `/config/driverAppBuild` y `/config/passengerAppBuild` | Incrementar solo después de subir una APK completa. |
| Usuarios dashboard | Firebase Authentication + claims | Crear usuarios individuales; no compartir la cuenta principal. |

## 4. Configurar Firebase

Desde la raíz del proyecto, con el proyecto del cliente seleccionado:

```bash
firebase use <FIREBASE_PROJECT_ID>
firebase deploy --only database,storage,functions
```

En Windows, un arranque en frío puede superar el límite de descubrimiento de
10 segundos del Firebase CLI. Si ocurre, define
`$env:FUNCTIONS_DISCOVERY_TIMEOUT='30'` y repite el comando; no modifica la
configuración desplegada ni el runtime de las funciones.

Verifica en la consola:

1. Que las reglas se hayan publicado.
2. Que existan Authentication Anonymous y Email/Password.
3. Que Storage esté activo.
4. Que Cloud Functions esté desplegando en la región configurada.
5. Que Scheduler esté disponible para `dispatchScheduledTrips`.

## 5. Configurar las apps Flutter

En cada app:

```bash
flutter pub get
flutter analyze
flutter build apk --release
```

Antes de compilar:

- Sustituye los valores de `lib/config.dart` por los del cliente.
- Instala `google-services.json` en `android/app/` cuando corresponda.
- Configura el token público de Mapbox mediante `--dart-define` antes de compilar.
- Define las variables `FLEET_KEYSTORE_*` con una keystore de producción; el build release no permite firma debug.
- Revisa permisos de ubicación en segundo plano, notificaciones, cámara e internet.
- Confirma que el `version`/build sea mayor al último publicado.

## 6. Publicar una app Android

### Publicación manual

1. Compila la APK firmada.
2. En el dashboard, abre **Configuración → Actualizaciones**.
3. Selecciona la app, la APK y el número de build.
4. Espera a que termine la carga.
5. Publica el número de build solo después de confirmar que el archivo está completo.
6. Abre cada app en un teléfono de prueba y verifica el aviso de actualización.

### Publicación automática con branding

1. En **Configuración → Apps**, define nombre e icono.
2. El dashboard crea una solicitud temporal.
3. Cloud Functions despacha GitHub Actions.
4. GitHub Actions restaura la firma y la configuración Firebase desde Secrets.
5. Compila APK y AAB, sube la APK al destino de publicación y confirma el build con el token temporal de un solo uso.
6. La app conserva localmente el build mínimo confirmado: si después no hay red, una actualización ya exigida sigue bloqueando una versión antigua.

El flujo automático expira las solicitudes después de 3 horas. La ejecución de GitHub Actions tiene un límite de 45 minutos.

## 7. Publicar el dashboard

El dashboard es un sitio estático. La configuración actual usa un script PowerShell para empaquetar solo la carpeta `dashboard/`, copiarla al servidor y reiniciar un servicio HTTP estático.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\publicar-dashboard.ps1 -Dominio dashboard.ejemplo.com
```

Antes de usar el script en una entrega:

- Sustituye servidor, usuario y llave SSH por los del cliente.
- Crea el registro DNS del dominio hacia el VPS y verifica que Caddy esté instalado.
- El script configura Caddy/Let's Encrypt y bloquea la publicación solo por IP/HTTP.
- Configura firewall y acceso administrativo.
- Verifica que las claves de Firebase y Maps correspondan al proyecto del cliente.
- Prueba la URL desde una red externa.

La configuración de Firebase Hosting del repositorio sirve el build web de la app de pasajeros; el dashboard operativo se publica por separado en el estado auditado. Si el cliente quiere una única plataforma de hosting, hay que definir esa migración como parte de la entrega.

Para publicar el build actualizado de pasajeros sin volver al proveedor anterior,
define `MAPBOX_ACCESS_TOKEN` y ejecuta desde la raíz:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\publicar-passenger-web.ps1
```

El script recompila `passenger-app/build/web` con Mapbox GL JS y luego publica
Firebase Hosting. No se debe publicar el directorio anterior sin recompilarlo.

## 8. Checklist de aceptación

### Acceso y servicios

- [ ] El pasajero puede registrarse y subir una credencial.
- [ ] Un QR vencido o revocado no permite crear nuevos viajes, y revocar el QR invalida sus accesos canjeados.
- [ ] El pasajero puede vincular correo, cerrar sesión, volver a entrar y recuperar contraseña sin SMS.
- [ ] El conductor puede registrarse con contraseña.
- [ ] Un administrador puede aprobar y rechazar documentos.
- [ ] Un supervisor puede entrar con su usuario individual.
- [ ] Las reglas de Database y Storage están publicadas.
- [ ] Las claves de Mapbox funcionan solo en dominios/paquetes autorizados.

### GPS y mapa

- [ ] El conductor obtiene permisos de ubicación en un teléfono físico.
- [ ] Se observa un primer envío inmediato.
- [ ] Se observan envíos posteriores aproximadamente cada 5 segundos.
- [ ] El dashboard mueve el marcador al recibir nuevas posiciones.
- [ ] El marcador se atenúa después de 45 segundos sin actualización.
- [ ] El marcador desaparece después de 3 minutos sin actualización.
- [ ] El conductor vuelve a aparecer cuando recupera la señal.

### Viajes

- [ ] Un viaje inmediato pasa de `searching` a `accepted` cuando hay vehículo elegible.
- [ ] Se respetan capacidad y aprobación del conductor.
- [ ] Dos pedidos simultáneos no reclaman el mismo conductor.
- [ ] El pasajero ve conductor, placa, vehículo y posición.
- [ ] El conductor completa llegada, abordaje y finalización.
- [ ] Al completar o cancelar, el vehículo queda disponible y el viaje aparece en historial.
- [ ] El pasajero puede calificar un viaje completado o reportar una incidencia terminal.
- [ ] El dashboard muestra incidencias abiertas y permite resolverlas o reabrirlas.
- [ ] Un viaje programado se despacha dentro de la ventana de 10 minutos.
- [ ] La modificación de destino avisa al conductor.

### Documentos y operación

- [ ] Se puede generar el PDF de revisión del conductor.
- [ ] Un rechazo identifica documentos y motivo.
- [ ] El conductor puede reenviar documentos corregidos.
- [ ] El dashboard puede administrar lugares y asignarlos.
- [ ] La asistencia registra conexión y desconexión.
- [ ] Se puede publicar una APK manual.
- [ ] Se puede ejecutar una compilación automática si el cliente la contrató.

## 9. Validación de conexiones y alertas

- [ ] Un conductor aprobado puede iniciar disponibilidad sin depender de un horario.
- [ ] Una desconexión manual o administrativa crea una alerta en el dashboard.
- [ ] Una pérdida de heartbeat durante más de 30 segundos cierra el turno y crea una alerta.
- [ ] **Alertas** muestra la insignia, toast y acciones de llamada/notificación/ubicación final.
- [ ] El administrador puede reconocer la alerta y queda registrada la hora y usuario que la atendió.
- [ ] El historial aparece en **Conductores → Alertas de desconexión**.

## 10. Paquete de transferencia al comprador

Entrega estos elementos en una carpeta o gestor de secretos separado del código:

- Identificador del proyecto Firebase y permisos del propietario.
- Cuenta de facturación de Firebase/Google Cloud y límites de presupuesto.
- Cuenta Mapbox, tokens restringidos y límites/alertas de consumo.
- URLs de producción del dashboard y Functions.
- Usuarios iniciales y matriz de roles.
- Keystore, alias y procedimiento de recuperación, bajo custodia del cliente.
- Secrets de GitHub Actions.
- Configuración de dominios, HTTPS, DNS y firewall.
- Inventario de APKs y builds publicados.
- Procedimiento de respaldo y restauración.
- Resultado firmado del checklist de aceptación.
- Contactos de soporte, ventanas de mantenimiento y responsabilidades.

## 10. Pendientes de seguridad antes de cerrar la entrega

1. Rotar las claves de cliente actualmente incluidas en el repositorio.
2. Restringir las claves por dominio, paquete, certificado y API.
3. Eliminar datos reales de prueba y revisar URLs de documentos ya publicados.
4. Migrar a HTTPS el dashboard usando un dominio DNS y Caddy o una plataforma segura.
5. Generar y proteger una keystore de producción.
6. Mantener las dependencias de Cloud Functions actualizadas.
7. Definir retención y eliminación de documentos, credenciales y ubicaciones con el cliente y su asesoría legal.
