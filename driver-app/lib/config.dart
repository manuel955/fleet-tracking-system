// Reemplaza estos valores con los de tu proyecto Firebase
// (Firebase Console > Configuracion del proyecto > General / Cuentas de servicio).
class AppConfig {
  static const String firebaseApiKey = 'AIzaSyABbcM0za__wtLsRm3amZa9P10OciEgkBY';
  static const String firebaseDbUrl = 'https://rastreoflota-53052-default-rtdb.firebaseio.com';
  static const String firebaseStorageBucket = 'rastreoflota-53052.firebasestorage.app';

  // Intervalo de envio de ubicacion en segundos.
  static const int locationIntervalSeconds = 15;

  // Codigo de pais por defecto para el telefono del conductor (Peru).
  static const String defaultPhoneCountryCode = '+51';

  // Numero de soporte de respaldo (Llamar/WhatsApp desde el boton
  // "Soporte"), solo se usa si config/supportPhone en Firebase no responde.
  // El numero real es editable desde el dashboard (Configuracion) y se
  // guarda en Firebase -- ver services/support_config_service.dart.
  static const String supportPhone = '+51929125443';

  // Chequeo de version: config/driverAppBuild en Firebase (numero) contra
  // PackageInfo.buildNumber (el "+N" de este pubspec.yaml) -- si el remoto
  // es mayor, se avisa al conductor. El APK se publica desde el dashboard
  // (Configuracion > Actualizaciones), que lo sube a Storage con este mismo
  // nombre fijo. Ver services/update_service.dart.
  static const String updateBuildConfigKey = 'driverAppBuild';
  static const String apkDownloadUrl =
      'https://firebasestorage.googleapis.com/v0/b/$firebaseStorageBucket/o/app_releases%2Fdriver-app.apk?alt=media';

  // La key del SDK nativo de Maps va en
  // android/app/src/main/AndroidManifest.xml (meta-data com.google.android.geo.API_KEY)
  // y en ios/Runner/AppDelegate.swift (ver driver-app/README.md). Esta de
  // aqui es la misma key en texto plano, necesaria porque la ruta en vivo
  // del viaje activo llama a la Routes API por HTTP directo (igual que
  // passenger-app/lib/config.dart), no a traves del SDK nativo.
  static const String googleMapsApiKey = 'AIzaSyAfPeC1qZW6eKFVz6oFzn_UYFQ5HMS0SsQ';
}
