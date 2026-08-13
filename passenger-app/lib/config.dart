// Mismo proyecto Firebase que driver-app y el dashboard.
class AppConfig {
  static const String firebaseApiKey =
      'AIzaSyBEGrZ6pl88j_GXExrdepJOvNiVA7UjoNQ';
  static const String firebaseDbUrl =
      'https://rastreoflota-53052-default-rtdb.firebaseio.com';
  static const String firebaseStorageBucket =
      'rastreoflota-53052.firebasestorage.app';
  static const String cloudFunctionsBaseUrl =
      'https://us-central1-rastreoflota-53052.cloudfunctions.net';

  // Migracion gradual al API del VPS. Vacio mantiene Firebase sin cambios.
  // Para una build de prueba: --dart-define=VPS_API_BASE_URL=https://api.tu-dominio
  static const String vpsApiBaseUrl = String.fromEnvironment(
    'VPS_API_BASE_URL',
    defaultValue: '',
  );
  static bool get useVpsBackend => vpsApiBaseUrl.trim().isNotEmpty;

  // Codigo de pais por defecto para el telefono del pasajero (Peru).
  static const String defaultPhoneCountryCode = '+51';

  // Numero de soporte de respaldo (Llamar/WhatsApp desde el boton
  // "Soporte"), solo se usa si config/supportPhone en Firebase no responde.
  // El numero real es editable desde el dashboard (Configuracion) y se
  // guarda en Firebase -- ver services/support_config_service.dart. Mismo
  // numero de respaldo que driver-app/lib/config.dart.
  static const String supportPhone = '+51929125443';

  // Paginas publicas requeridas por Google Play y accesibles desde la app.
  // Se publican junto con el hosting existente de pasajeros; no se crea ni
  // se reutiliza ningun dominio de la tienda.
  static const String privacyPolicyUrl =
      'https://rastreoflota-53052.web.app/privacy-policy.html';
  static const String deleteAccountUrl =
      'https://rastreoflota-53052.web.app/apl-pasajero/eliminacion-de-cuenta.html';
  static const String supportEmail = 'manuel_cortezballardo@outlook.com';

  // El pasajero refresca la posicion recibida del conductor cada 5 segundos.
  // Las consultas de ruta usan un intervalo y un umbral independientes.
  static const Duration driverLocationPollInterval = Duration(seconds: 5);
  static const Duration routeRefreshInterval = Duration(seconds: 30);
  static const double routeRecalculationDistanceMeters = 50;

  // Chequeo de version: config/passengerAppBuild en Firebase (numero) contra
  // PackageInfo.buildNumber (el "+N" de este pubspec.yaml) -- si el remoto
  // es mayor, se avisa al pasajero. El APK se publica desde el dashboard
  // (Configuracion > Actualizaciones), que lo sube a Storage con este mismo
  // nombre fijo. Ver services/update_service.dart. Mismo mecanismo que
  // driver-app/lib/config.dart.
  static const String updateBuildConfigKey = 'passengerAppBuild';
  static const String apkDownloadUrl =
      'https://firebasestorage.googleapis.com/v0/b/$firebaseStorageBucket/o/app_releases%2Fpassenger-app.apk?alt=media';

  // Token del SDK de Mapbox, inyectado en tiempo de compilacion.
  // Se inyecta al compilar: flutter build apk
  // --dart-define=MAPBOX_ACCESS_TOKEN=pk....
  static const String mapboxAccessToken = String.fromEnvironment(
    'MAPBOX_ACCESS_TOKEN',
    // Token público de Mapbox: el --dart-define puede reemplazarlo en builds
    // de otro entorno, pero una build local no debe quedar sin mapa.
    defaultValue:
        'pk.eyJ1IjoiYW5mdXJleCIsImEiOiJjbXNlMHFxamgwNGlvMndweXo2aGFtbGlpIn0.bxWU-uN8FFTm0u7HZai9oQ',
  );
  static const String mapboxStyleUri = String.fromEnvironment(
    'MAPBOX_STYLE_URI',
    defaultValue: 'mapbox://styles/mapbox/standard',
  );
}
