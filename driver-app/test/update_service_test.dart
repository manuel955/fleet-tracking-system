import 'package:fleet_driver_app/services/update_service.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('conserva la exigencia de actualizar cuando no hay red', () {
    expect(
      UpdateService.requiresBuildUpdate(localBuild: 54, cachedBuild: 55),
      isTrue,
    );
    expect(
      UpdateService.requiresBuildUpdate(localBuild: 55, cachedBuild: 55),
      isFalse,
    );
  });

  test('nunca reduce el build requerido ya confirmado', () {
    expect(
      UpdateService.requiresBuildUpdate(
        localBuild: 54,
        remoteBuild: 53,
        cachedBuild: 56,
      ),
      isTrue,
    );
  });
}
