# APL Conductores

Aplicación Flutter para registrar conductores, mantener un turno con GPS en segundo plano y ejecutar servicios asignados automáticamente.

## Flujo actual

1. El conductor crea o recupera una cuenta con correo y contraseña.
2. Completa datos personales y del vehículo.
3. Sube foto de perfil, DNI (un PDF o dos imágenes), licencia, SOAT, tarjeta de circulación, revisión técnica, récord del conductor y certificado laboral.
4. Registra la vigencia de licencia, SOAT y revisión técnica.
5. El perfil queda `pending_review`; un administrador puede aprobarlo o rechazar grupos concretos para corrección.
6. Solo un conductor aprobado y no suspendido puede iniciar turno y enviar GPS.
7. El backend asigna el servicio; el conductor confirma llegada, inicio y finalización cerca del punto correspondiente.

La cuenta admite recuperación de contraseña. La sesión se guarda cifrada y solo un dispositivo puede conservar la sesión operativa activa. El servicio Android de ubicación no es exportado a otras aplicaciones.

## GPS y notificaciones

- La app solicita ubicación precisa y en segundo plano.
- Envía posición aproximadamente cada cinco segundos durante el turno.
- FCM avisa asignaciones, cambios de destino, cancelaciones y decisiones de aprobación; el polling mantiene un respaldo con la app abierta.
- Una pérdida prolongada de heartbeat genera una alerta operativa y evita nuevas asignaciones.

## Configuración y compilación

- Firebase: `lib/config.dart` y `android/app/google-services.json`.
- Mapbox: inyectar un token público restringido al compilar.
- La firma release requiere `FLEET_KEYSTORE_PATH`, `FLEET_KEYSTORE_PASSWORD`, `FLEET_KEY_ALIAS` y `FLEET_KEY_PASSWORD`. No se firma release con la llave debug.
- Android mínimo: API 23.

```powershell
flutter pub get
flutter analyze
flutter test
flutter build apk --release --dart-define=MAPBOX_ACCESS_TOKEN=$env:MAPBOX_ACCESS_TOKEN
flutter build appbundle --release --dart-define=MAPBOX_ACCESS_TOKEN=$env:MAPBOX_ACCESS_TOKEN
```

Los permisos, restricciones de batería, GPS de fondo, voz, vibración, recuperación de contraseña y actualización obligatoria deben validarse en un teléfono Android físico.
