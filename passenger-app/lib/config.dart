// Mismo proyecto Firebase que driver-app y el dashboard.
class AppConfig {
  static const String firebaseApiKey = 'AIzaSyABbcM0za__wtLsRm3amZa9P10OciEgkBY';
  static const String firebaseDbUrl = 'https://rastreoflota-53052-default-rtdb.firebaseio.com';
  static const String firebaseStorageBucket = 'rastreoflota-53052.firebasestorage.app';
  static const String cloudFunctionsBaseUrl = 'https://us-central1-rastreoflota-53052.cloudfunctions.net';

  // Codigo de pais por defecto para el telefono del pasajero (Peru).
  static const String defaultPhoneCountryCode = '+51';

  // Numero de soporte de respaldo (Llamar/WhatsApp desde el boton
  // "Soporte"), solo se usa si config/supportPhone en Firebase no responde.
  // El numero real es editable desde el dashboard (Configuracion) y se
  // guarda en Firebase -- ver services/support_config_service.dart. Mismo
  // numero de respaldo que driver-app/lib/config.dart.
  static const String supportPhone = '+51929125443';

  // Chequeo de version: config/passengerAppBuild en Firebase (numero) contra
  // PackageInfo.buildNumber (el "+N" de este pubspec.yaml) -- si el remoto
  // es mayor, se avisa al pasajero. El APK se publica desde el dashboard
  // (Configuracion > Actualizaciones), que lo sube a Storage con este mismo
  // nombre fijo. Ver services/update_service.dart. Mismo mecanismo que
  // driver-app/lib/config.dart.
  static const String updateBuildConfigKey = 'passengerAppBuild';
  static const String apkDownloadUrl =
      'https://firebasestorage.googleapis.com/v0/b/$firebaseStorageBucket/o/app_releases%2Fpassenger-app.apk?alt=media';

  // Misma key que android/app/src/main/AndroidManifest.xml (meta-data
  // com.google.android.geo.API_KEY). Aqui tambien se necesita en texto
  // plano porque el buscador de lugares llama a la Places API (New) por
  // HTTP directo, no a traves del SDK nativo de Maps.
  static const String googleMapsApiKey = 'AIzaSyAfPeC1qZW6eKFVz6oFzn_UYFQ5HMS0SsQ';
}
