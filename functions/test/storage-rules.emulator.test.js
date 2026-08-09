const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require('@firebase/rules-unit-testing');
require('firebase/compat/storage');

const emulatorHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;

if (!emulatorHost) {
  test('Storage rules emulator suite', { skip: 'requires Firebase Storage emulator' }, () => {});
} else {
  const separator = emulatorHost.lastIndexOf(':');
  const host = emulatorHost.slice(0, separator);
  const port = Number(emulatorHost.slice(separator + 1));
  const rules = fs.readFileSync(
    path.join(__dirname, '..', '..', 'database', 'storage.rules'),
    'utf8',
  );
  let environment;

  test.before(async () => {
    environment = await initializeTestEnvironment({
      projectId: 'rastreoflota-53052',
      storage: { host, port, rules },
    });
  });

  test.beforeEach(async () => {
    await environment.clearStorage();
  });

  test.after(async () => {
    await environment.cleanup();
  });

  function bytes() {
    return new Uint8Array([137, 80, 78, 71]);
  }

  async function seed(pathName, contentType) {
    await environment.withSecurityRulesDisabled(async (context) => {
      await context.storage().ref(pathName).put(bytes(), { contentType });
    });
  }

  function dashboardContext(uid, role, admin = false) {
    return environment.authenticatedContext(uid, {
      dashboardUser: true,
      dashboardAdmin: admin,
      dashboardRole: role,
    });
  }

  test('a passenger only uploads images inside their credential prefix', async () => {
    const owner = environment.authenticatedContext('passenger-1');
    const storage = owner.storage();

    await assertSucceeds(storage.ref(
      'passenger_credentials/passenger-1/credential.png',
    ).put(
      bytes(),
      { contentType: 'image/png' },
    ));
    await assertFails(storage.ref(
      'passenger_credentials/passenger-2/credential.png',
    ).put(
      bytes(),
      { contentType: 'image/png' },
    ));
    await assertFails(storage.ref(
      'passenger_credentials/passenger-1/credential.pdf',
    ).put(
      bytes(),
      { contentType: 'application/pdf' },
    ));
  });

  test('credential reads allow the owner and dashboard staff except coordinators', async () => {
    const filePath = 'passenger_credentials/passenger-1/credential.png';
    await seed(filePath, 'image/png');
    const owner = environment.authenticatedContext('passenger-1');
    const other = environment.authenticatedContext('passenger-2');
    const supervisor = dashboardContext('supervisor-1', 'SUPERVISOR');
    const coordinator = dashboardContext('coordinator-1', 'COORDINATOR');

    await assertSucceeds(owner.storage().ref(filePath).getMetadata());
    await assertSucceeds(supervisor.storage().ref(filePath).getMetadata());
    await assertFails(other.storage().ref(filePath).getMetadata());
    await assertFails(coordinator.storage().ref(filePath).getMetadata());
  });

  test('driver documents preserve owner writes and exclude coordinators from reads', async () => {
    const imagePath = 'driver_documents/driver-1/license.png';
    const pdfPath = 'driver_documents/driver-1/background.pdf';
    const owner = environment.authenticatedContext('driver-1');
    const other = environment.authenticatedContext('driver-2');
    const supervisor = dashboardContext('supervisor-1', 'SUPERVISOR');
    const coordinator = dashboardContext('coordinator-1', 'COORDINATOR');

    await assertSucceeds(owner.storage().ref(imagePath).put(bytes(), {
      contentType: 'image/png',
    }));
    await assertSucceeds(owner.storage().ref(pdfPath).put(bytes(), {
      contentType: 'application/pdf',
    }));
    await assertFails(other.storage().ref(imagePath).put(bytes(), {
      contentType: 'image/png',
    }));
    await assertSucceeds(supervisor.storage().ref(imagePath).getMetadata());
    await assertFails(coordinator.storage().ref(imagePath).getMetadata());
  });

  test('APK publishing is public to read but restricted to dashboard administrators', async () => {
    const releasePath = 'app_releases/driver-app.apk';
    const admin = dashboardContext('admin-1', 'ADMIN', true);
    const supervisor = dashboardContext('supervisor-1', 'SUPERVISOR');
    const anonymous = environment.unauthenticatedContext();
    const apkMetadata = { contentType: 'application/vnd.android.package-archive' };

    await assertFails(supervisor.storage().ref(releasePath).put(bytes(), apkMetadata));
    await assertFails(admin.storage().ref(releasePath).put(bytes(), {
      contentType: 'application/octet-stream',
    }));
    await assertSucceeds(admin.storage().ref(releasePath).put(bytes(), apkMetadata));
    await assertSucceeds(anonymous.storage().ref(releasePath).getMetadata());
  });

  test('storage emulator environment was configured', () => {
    assert.equal(Number.isInteger(port), true);
    assert.equal(port > 0, true);
  });
}
