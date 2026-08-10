# APL Pasajeros

Aplicación Flutter para solicitar transporte corporativo sin cobro por viaje.
Por decisión del modelo operativo no existe pasarela ni pantalla de pago.

## Flujo actual

1. El pasajero activa su acceso con un QR temporal emitido por un hotel.
2. Registra nombre, teléfono de contacto y foto de credencial.
3. Puede vincular correo y contraseña para recuperar la misma cuenta; no se usa autenticación por SMS.
4. Elige origen, destino y cantidad de pasajeros, o programa el servicio con 15 minutos a 30 días de anticipación.
5. Cloud Functions crea la solicitud de forma idempotente y asigna el vehículo elegible más cercano.
6. La app muestra conductor, vehículo, ruta y ubicación reciente. Una ubicación de más de 30 segundos se marca como desactualizada.
7. Al finalizar, el pasajero puede calificar el servicio o reportar una incidencia desde **Actividad**.

El historial normal muestra los últimos siete días. Un viaje activo o programado se recupera desde Firebase si la aplicación se cierra antes de guardar el ID local; también se conserva una copia local para mostrar un estado seguro cuando no hay conexión.

## Configuración

- Firebase: `lib/config.dart` y `android/app/google-services.json`.
- Mapbox: inyectar un token público restringido al compilar:

  ```powershell
  flutter build apk --release --dart-define=MAPBOX_ACCESS_TOKEN=$env:MAPBOX_ACCESS_TOKEN
  ```

- La firma release requiere `FLEET_KEYSTORE_PATH`, `FLEET_KEYSTORE_PASSWORD`, `FLEET_KEY_ALIAS` y `FLEET_KEY_PASSWORD`. No existe respaldo con firma debug para builds release.
- Android mínimo: API 23, necesario para el almacenamiento cifrado de sesión.

## Validación

```powershell
flutter pub get
flutter analyze
flutter test
```

La validación final de GPS, cámara, notificaciones, deep links del QR y actualización de APK debe hacerse en un teléfono Android físico.
