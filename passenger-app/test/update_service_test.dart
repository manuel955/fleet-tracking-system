import 'package:fleet_passenger_app/services/update_service.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('conserva la exigencia de actualizar cuando no hay red', () {
    expect(
      UpdateService.requiresBuildUpdate(localBuild: 43, cachedBuild: 44),
      isTrue,
    );
    expect(
      UpdateService.requiresBuildUpdate(localBuild: 44, cachedBuild: 44),
      isFalse,
    );
  });

  test('nunca reduce el build requerido ya confirmado', () {
    expect(
      UpdateService.requiresBuildUpdate(
        localBuild: 43,
        remoteBuild: 42,
        cachedBuild: 45,
      ),
      isTrue,
    );
  });
}
