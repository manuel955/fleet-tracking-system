import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('el servicio GPS conserva el override defensivo del manifiesto', () {
    final manifest = File('android/app/src/main/AndroidManifest.xml')
        .readAsStringSync();
    const serviceName =
        'android:name="id.flutter.flutter_background_service.BackgroundService"';
    final nameIndex = manifest.indexOf(serviceName);

    expect(nameIndex, greaterThanOrEqualTo(0));
    final serviceStart = manifest.lastIndexOf('<service', nameIndex);
    final serviceEnd = manifest.indexOf('/>', nameIndex);
    expect(serviceStart, greaterThanOrEqualTo(0));
    expect(serviceEnd, greaterThan(nameIndex));

    final serviceDeclaration = manifest.substring(serviceStart, serviceEnd);
    expect(
      manifest,
      contains('xmlns:tools="http://schemas.android.com/tools"'),
    );
    expect(serviceDeclaration, contains('android:exported="false"'));
    expect(
      serviceDeclaration,
      contains('tools:replace="android:exported"'),
    );
  });
}
