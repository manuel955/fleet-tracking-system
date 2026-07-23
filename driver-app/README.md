# Fleet Driver App (Flutter) — version minima: solo GPS

Version simplificada a proposito: sin formulario de registro. Al abrir la
app, se autentica de forma anonima contra Firebase (el UID que le asigna
Firebase es su "ID de conductor"), muestra su posicion en un mapa de
Google Maps, y al presionar "Iniciar rastreo" empieza a enviar su
ubicacion en segundo plano cada 15 segundos. Incluye un panel de
"Registro de actividad" en pantalla para ver en tiempo real cada paso
(permiso, GPS, envio a Firebase) — util porque `print()` no es visible
cuando el codigo corre en el isolate de segundo plano.

## Por que antes no capturaba ubicacion real

En la version anterior, `LocationService.initialize()` habia quedado
comentado en `main()`, asi que el servicio en segundo plano nunca se
configuraba y `start()` no tenia nada que iniciar. Ya esta corregido:
`initialize()` se llama siempre al arrancar la app.

## 1. Generar el proyecto nativo

Este directorio contiene solo el codigo Dart (`lib/`) y `pubspec.yaml`. Para
obtener los proyectos nativos `android/` e `ios/`, corre dentro de esta
carpeta:

```bash
flutter create --org com.tuempresa --project-name fleet_driver_app .
flutter pub get
```

Esto generara `android/` e `ios/` sin sobreescribir `lib/` ni `pubspec.yaml`
si respondes "no" a sobreescribir cuando se te pregunte (o corre con
`--overwrite` y vuelve a copiar `lib/` despues).

## 2. Permisos nativos requeridos

### Android (`android/app/src/main/AndroidManifest.xml`)

Agrega dentro de `<manifest>`, antes de `<application>`:

```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION"/>
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION"/>
<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>
<uses-permission android:name="android.permission.INTERNET"/>
```

Dentro de `<application>`, agrega el servicio en primer plano y la API key
de Google Maps:

```xml
<meta-data
    android:name="com.google.android.geo.API_KEY"
    android:value="TU_API_KEY_DE_GOOGLE_MAPS"/>

<service
    android:name="id.flutter.flutter_background_service.BackgroundService"
    android:foregroundServiceType="location"
    android:exported="false"/>
```

### iOS (`ios/Runner/Info.plist`)

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>Necesitamos tu ubicacion para rastrear el vehiculo asignado.</string>
<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
<string>Necesitamos tu ubicacion en segundo plano para el rastreo de flota.</string>
<key>UIBackgroundModes</key>
<array>
    <string>location</string>
    <string>fetch</string>
    <string>processing</string>
</array>
```

Y en `ios/Runner/AppDelegate.swift`, agrega la key de Google Maps antes de
`GeneratedPluginRegistrant.register`:

```swift
import GoogleMaps // agregar este import

GMSServices.provideAPIKey("TU_API_KEY_DE_GOOGLE_MAPS")
```

## 3. Configurar Firebase y Google Maps

- Edita [`lib/config.dart`](lib/config.dart) con tu API Key y URL de Realtime
  Database (Firebase Console > Configuracion del proyecto > General).
- La API key de **Google Maps** no va en `config.dart`: va directamente en
  `AndroidManifest.xml` y `AppDelegate.swift` como se muestra arriba.
  Consiguela en https://console.cloud.google.com/google/maps-apis
  habilitando "Maps SDK for Android" / "Maps SDK for iOS".

## 4. Correr en un dispositivo fisico

El GPS en segundo plano no funciona de forma confiable en emuladores.
Conecta un telefono real con depuracion USB activada:

```bash
flutter pub get
flutter run --release
```

## 5. Probar que si capture ubicacion real

1. Abre la app. Arriba veras tu "ID" (los primeros caracteres del UID
   anonimo) — es el mismo ID con el que aparecera en el dashboard.
2. Presiona **"Iniciar rastreo"**. Te pedira permiso de ubicacion dos veces
   (primero "mientras se usa", luego "todo el tiempo" / "siempre") — acepta
   ambos. En Android, si el sistema solo te deja elegir "solo esta vez",
   ve a Ajustes > Apps > Fleet Driver > Permisos > Ubicacion y cambia a
   "Permitir todo el tiempo".
3. Observa el panel **"Registro de actividad"**: deberias ver en segundos
   "Obteniendo posicion GPS...", luego "GPS ok: lat, lng" y
   "Enviado a Firebase correctamente" cada 15 segundos.
4. El mapa debe centrarse en tu ubicacion real (no en Ciudad de Mexico por
   defecto) y mostrar un marcador que se mueve si caminas/manejas.
5. Si algo falla, el log te dira exactamente en que paso: GPS del telefono
   apagado, permiso denegado, o el codigo de error que devolvio Firebase.
