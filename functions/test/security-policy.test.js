const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const functionsSource = fs.readFileSync(
  path.join(__dirname, '..', 'index.js'),
  'utf8',
);
const matchingSource = fs.readFileSync(
  path.join(__dirname, '..', 'matching.js'),
  'utf8',
);
const databaseRules = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', 'database', 'firebase-rules.json'),
  'utf8',
));
const storageRules = fs.readFileSync(
  path.join(__dirname, '..', '..', 'database', 'storage.rules'),
  'utf8',
);
const brandedWorkflow = fs.readFileSync(
  path.join(__dirname, '..', '..', '.github', 'workflows', 'build-branded-app.yml'),
  'utf8',
);
const driverWorkflow = fs.readFileSync(
  path.join(__dirname, '..', '..', '.github', 'workflows', 'build-driver-aab.yml'),
  'utf8',
);
const driverGradle = fs.readFileSync(
  path.join(__dirname, '..', '..', 'driver-app', 'android', 'app', 'build.gradle.kts'),
  'utf8',
);
const passengerGradle = fs.readFileSync(
  path.join(__dirname, '..', '..', 'passenger-app', 'android', 'app', 'build.gradle.kts'),
  'utf8',
);
const driversAdminSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'dashboard', 'js', 'drivers-admin.js'),
  'utf8',
);

test('branding builds require the dashboard manager claim', () => {
  const start = functionsSource.indexOf('exports.requestAppBrandingBuild');
  const end = functionsSource.indexOf('exports.getAppBrandingBuild', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const handler = functionsSource.slice(start, end);

  assert.match(handler, /await requireDashboardManager\(req\)/);
  assert.doesNotMatch(handler, /await requireDashboardAdmin\(req\)/);
});

test('branding build numbers are reserved and published monotonically', () => {
  const requestStart = functionsSource.indexOf('exports.requestAppBrandingBuild');
  const requestEnd = functionsSource.indexOf('exports.getAppBrandingBuild', requestStart);
  const completeStart = functionsSource.indexOf('exports.completeAppBrandingBuild');
  const completeEnd = functionsSource.indexOf('exports.migratePassengerAccount', completeStart);
  const requestHandler = functionsSource.slice(requestStart, requestEnd);
  const completeHandler = functionsSource.slice(completeStart, completeEnd);

  assert.match(requestHandler, /appBuildSequences\/\$\{appKey\}/);
  assert.match(requestHandler, /nextBuildNumber/);
  assert.match(completeHandler, /buildPublicationDecision/);
  assert.match(completeHandler, /superseded/);
});

test('branding build credentials never expose a signing URL', () => {
  const requestStart = functionsSource.indexOf('exports.requestAppBrandingBuild');
  const requestEnd = functionsSource.indexOf('exports.getAppBrandingBuild', requestStart);
  const getStart = requestEnd;
  const getEnd = functionsSource.indexOf('exports.completeAppBrandingBuild', getStart);
  const handlers = functionsSource.slice(requestStart, getEnd);

  assert.doesNotMatch(handlers, /signingUrl/);
  assert.doesNotMatch(functionsSource, /app-branding\/signing/);
  assert.doesNotMatch(brandedWorkflow, /signingUrl/);
  assert.match(brandedWorkflow, /ANDROID_RELEASE_KEYSTORE_BASE64/);
  assert.match(brandedWorkflow, /ANDROID_RELEASE_CERT_SHA256/);
  assert.match(brandedWorkflow, /test -n "\$ANDROID_RELEASE_CERT_SHA256"/);
  assert.match(driverWorkflow, /test -n "\$ANDROID_RELEASE_CERT_SHA256"/);
});

test('release Gradle configuration never falls back to debug signing', () => {
  for (const source of [driverGradle, passengerGradle]) {
    assert.doesNotMatch(source, /signingConfigs\.getByName\(["']debug["']\)/);
    assert.doesNotMatch(source, /storePassword\s*=\s*["']android["']/);
    assert.doesNotMatch(source, /keyAlias\s*=\s*["']androiddebugkey["']/);
    assert.match(source, /fleetSigningReady/);
    assert.match(source, /gradle\.taskGraph\.whenReady/);
    assert.match(source, /allTasks\.any/);
    assert.match(source, /throw GradleException/);
  }
});

test('driver location reads are scoped to an active assigned trip', () => {
  const readRule = databaseRules.rules.driverLocations.$driverId['.read'];

  assert.match(readRule, /auth\.uid === \$driverId/);
  assert.match(readRule, /auth\.token\.dashboardUser === true/);
  assert.match(readRule, /currentTripId/);
  assert.match(readRule, /passengerId.*auth\.uid/);
  assert.match(readRule, /accepted\|arrived_at_pickup\|in_progress/);
  assert.notEqual(readRule, "auth != null && auth.token.dashboardRole !== 'COORDINATOR'");
});

test('driver location and shift state can only be written by trusted Functions', () => {
  const driverRules = databaseRules.rules.drivers.$driverId;
  const locationRules = databaseRules.rules.driverLocations.$driverId;

  for (const field of ['lat', 'lng', 'heading', 'lastUpdate', 'turno_activo']) {
    assert.equal(driverRules[field]['.write'], undefined, `${field} must not be client-writable`);
  }
  for (const field of ['lat', 'lng', 'heading', 'lastUpdate']) {
    assert.equal(locationRules[field]['.write'], undefined, `location ${field} must not be client-writable`);
  }
  assert.equal(locationRules['.write'], false);
});

test('driver identity and review fields preserve the admin boundary', () => {
  const configRules = databaseRules.rules.config;
  const driverRules = databaseRules.rules.drivers.$driverId;

  assert.match(configRules.supportPhone['.write'], /dashboardAdmin/);
  for (const field of ['email', 'name', 'phone', 'dni', 'plate', 'vehicleType', 'vehicleColor', 'vehicleSeats']) {
    assert.equal(driverRules[field]['.write'], undefined, `${field} must only be set during initial registration or by Functions`);
  }
  for (const field of ['approvalStatus', 'rejectionReason', 'rejectionFieldKeys', 'reviewedAt', 'reviewedBy']) {
    assert.match(driverRules[field]['.write'], /dashboardAdmin/, `${field} must require dashboardAdmin`);
    assert.doesNotMatch(driverRules[field]['.write'], /dashboardUser/);
  }
});

test('driver registration is completed and approved through server validation', () => {
  const registrationStart = functionsSource.indexOf('exports.completeDriverRegistration');
  const registrationEnd = functionsSource.indexOf('exports.resubmitDriverApplication', registrationStart);
  const managementStart = functionsSource.indexOf('exports.manageDrivers');
  const managementEnd = functionsSource.indexOf('exports.manageOperationAlert', managementStart);
  const registrationHandler = functionsSource.slice(registrationStart, registrationEnd);
  const managementHandler = functionsSource.slice(managementStart, managementEnd);

  assert.match(registrationHandler, /driverApplicationIssues/);
  assert.match(registrationHandler, /reserveDriverApplicationIdentities/);
  assert.match(managementHandler, /action === 'approve'/);
  assert.match(managementHandler, /driverApplicationIssues/);
  assert.match(driversAdminSource, /manageDriver\(\{ action: 'approve', driverId \}\)/);
});

test('driver corrections are restricted to the rejected groups', () => {
  const start = functionsSource.indexOf('exports.resubmitDriverApplication');
  const end = functionsSource.indexOf('exports.manageDrivers', start);
  const handler = functionsSource.slice(start, end);

  assert.match(handler, /rejectionFields\.has\('personalData'\)/);
  assert.match(handler, /rejectionFields\.has\('vehicleData'\)/);
  assert.match(handler, /rejectionFields\.has\(document\.key\)/);
  assert.match(handler, /driverRef\.transaction/);
  assert.match(handler, /driverApplicationIssues/);
});

test('driver suspension is server controlled, audited and excluded from matching', () => {
  const start = functionsSource.indexOf('exports.manageDrivers');
  const end = functionsSource.indexOf('exports.manageOperationAlert', start);
  const handler = functionsSource.slice(start, end);

  assert.match(handler, /action === 'suspend'/);
  assert.match(handler, /DRIVER_SUSPENDED/);
  assert.match(handler, /action === 'reinstate'/);
  assert.match(matchingSource, /d\.suspended === true/);
  assert.match(databaseRules.rules.auditLogs['.read'], /dashboardAdmin/);
  assert.equal(databaseRules.rules.auditLogs['.write'], false);
});

test('dashboard cancellation uses an authenticated conditional server write', () => {
  const start = functionsSource.indexOf('exports.cancelDashboardTrip');
  const end = functionsSource.indexOf('exports.syncCoordinatorTrip', start);
  const handler = functionsSource.slice(start, end);

  assert.match(handler, /requireDashboardManager/);
  assert.match(handler, /readDatabaseWithEtag/);
  assert.match(handler, /putDatabaseIfUnchanged/);
  assert.match(handler, /prepareDashboardCancellation/);
});

test('full names are not treated as globally unique driver identifiers', () => {
  assert.match(functionsSource, /const DRIVER_UNIQUE_FIELDS = \['email', 'phone', 'plate', 'dni'\]/);
  assert.doesNotMatch(functionsSource, /const DRIVER_UNIQUE_FIELDS = \[[^\]]*'name'/);
});

test('driver document expiry fields require an owner and a future timestamp', () => {
  const driverRules = databaseRules.rules.drivers.$driverId;
  for (const field of ['licenseExpiresAt', 'soatExpiresAt', 'technicalReviewExpiresAt']) {
    assert.match(driverRules[field]['.write'], /auth\.uid === \$driverId/);
    assert.match(driverRules[field]['.validate'], /newData\.val\(\) > now/);
  }
});

test('passengers can retry an unavailable trip without changing server-owned assignment fields', () => {
  const tripRules = databaseRules.rules.trips.$tripId;

  assert.match(tripRules['.write'], /no_drivers_available.*searching/);
  assert.match(tripRules.requestedAt['.validate'], /no_drivers_available.*searching/);
  assert.match(tripRules['.validate'], /newData\.child\('driverId'\)\.val\(\) == data\.child\('driverId'\)\.val\(\)/);
  assert.match(tripRules['.validate'], /newData\.child\('completedAt'\)\.val\(\) == data\.child\('completedAt'\)\.val\(\)/);
});

test('reintento autenticado conserva el viaje y despacha mediante transicion server-side', () => {
  const start = functionsSource.indexOf('exports.retryPassengerTrip');
  const end = functionsSource.indexOf('exports.createCoordinatorTrip', start);
  const handler = functionsSource.slice(start, end);
  assert.match(handler, /requireAuthenticatedUser/);
  assert.match(handler, /trip\.passengerId !== passenger\.uid/);
  assert.match(handler, /trip\.status !== 'no_drivers_available'/);
  assert.match(handler, /status: 'searching'/);
  assert.match(handler, /putDatabaseIfUnchanged/);
});

test('viajes cerrados envian deep-link de calificacion y cancelaciones incluyen estado', () => {
  const start = functionsSource.indexOf('exports.handleTripStatusChange');
  const end = functionsSource.indexOf('exports.recordDriverConnection', start);
  const handler = functionsSource.slice(start, end);
  assert.match(handler, /'trip_completed'/);
  assert.match(handler, /'rate-trip'/);
  assert.match(handler, /'trip_cancelled'/);
  assert.match(handler, /status: 'cancelled'/);
  assert.match(handler, /deepLink/);
});

test('passenger trip creation is idempotent and serialized on the server', () => {
  const start = functionsSource.indexOf('exports.createPassengerTrip');
  const end = functionsSource.indexOf('exports.createCoordinatorTrip', start);
  const handler = functionsSource.slice(start, end);

  assert.match(handler, /const tripId = `\$\{passenger\.uid\}_\$\{requestId\}`/);
  assert.match(handler, /passengerTripLocks\/\$\{passenger\.uid\}/);
  assert.match(handler, /passengerTripConflict/);
  assert.match(handler, /tripRef\.transaction\(\(current\) => current \|\| trip\)/);
  assert.match(handler, /passengerAccessIsActive/);
});

test('passenger history keeps tokens out of URLs and feedback is server controlled', () => {
  const historyStart = functionsSource.indexOf('exports.getMyTrips');
  const historyHandler = functionsSource.slice(historyStart);
  const feedbackStart = functionsSource.indexOf('exports.submitTripFeedback');
  const feedbackEnd = functionsSource.indexOf('exports.getMyTrips', feedbackStart);
  const feedbackHandler = functionsSource.slice(feedbackStart, feedbackEnd);

  assert.match(historyHandler, /requireAuthenticatedUser\(req\)/);
  assert.doesNotMatch(historyHandler, /req\.query\.idToken/);
  assert.match(feedbackHandler, /buildTripFeedback/);
  assert.match(feedbackHandler, /tripFeedback\/\$\{tripId\}/);
  assert.match(feedbackHandler, /readDatabaseWithEtag/);
  assert.match(feedbackHandler, /putDatabaseIfUnchanged/);
  assert.equal(databaseRules.rules.tripFeedback.$tripId['.write'], false);
  assert.match(databaseRules.rules.tripFeedback.$tripId['.read'], /passengerId/);
  assert.match(databaseRules.rules.tripFeedback.$tripId['.read'], /dashboardAdmin/);
  assert.doesNotMatch(databaseRules.rules.tripFeedback.$tripId['.read'], /dashboardUser/);
  assert.match(databaseRules.rules.tripFeedback['.read'], /dashboardAdmin/);
  assert.doesNotMatch(databaseRules.rules.tripFeedback['.read'], /dashboardUser/);
});

test('trip incidents are admin-only and use conditional writes', () => {
  const manageStart = functionsSource.indexOf('exports.manageTripFeedback');
  const manageEnd = functionsSource.indexOf('exports.getMyTrips', manageStart);
  const handler = functionsSource.slice(manageStart, manageEnd);

  assert.match(handler, /requireDashboardManager/);
  assert.match(handler, /readDatabaseWithEtag/);
  assert.match(handler, /putDatabaseIfUnchanged/);
  assert.doesNotMatch(handler, /\.transaction\(/);
  assert.match(driversAdminSource, /if \(role === 'ADMIN'\)/);
  assert.match(driversAdminSource, /return \['approved', 'suspended', 'all'\]/);
});

test('scheduled dispatch waits while the passenger has another active trip', () => {
  const start = functionsSource.indexOf('exports.dispatchScheduledTrips');
  const end = functionsSource.indexOf('exports.reconcileClosedTripAssignments', start);
  const handler = functionsSource.slice(start, end);

  assert.match(handler, /delete passengerTrips\[tripId\]/);
  assert.match(handler, /passengerTripConflict\(passengerTrips, scheduledAt, now\)/);
  assert.match(handler, /ACTIVE_TRIP_EXISTS/);
});

test('location and trip transitions use conditional ETag writes', () => {
  const locationStart = functionsSource.indexOf('exports.updateDriverLocation');
  const locationEnd = functionsSource.indexOf('exports.advanceDriverTrip', locationStart);
  const advanceEnd = functionsSource.indexOf('exports.updateDriverProfileOnce', locationEnd);
  const locationHandler = functionsSource.slice(locationStart, locationEnd);
  const advanceHandler = functionsSource.slice(locationEnd, advanceEnd);

  assert.match(locationHandler, /readDatabaseWithEtag/);
  assert.match(locationHandler, /putDatabaseIfUnchanged/);
  assert.doesNotMatch(locationHandler, /driverRef\.transaction/);
  assert.match(advanceHandler, /readDatabaseWithEtag/);
  assert.match(advanceHandler, /putDatabaseIfUnchanged/);
  assert.doesNotMatch(advanceHandler, /tripRef\.transaction/);
});

test('driver assignment only updates trips that remain dispatchable', () => {
  assert.match(matchingSource, /function updateTripWhileDispatchable/);
  assert.match(matchingSource, /\['searching', 'scheduled'\]\.includes\(current\.status\)/);
  assert.match(matchingSource, /assigned = await updateTripWhileDispatchable/);
  assert.match(matchingSource, /if \(!assigned\) \{\s*await releaseDriver/);
  assert.match(matchingSource, /claimDriverWithToken\([^)]*now = Date\.now\(\)\)/);
  assert.match(matchingSource, /assignmentClaimedAt: now/);
});

test('passenger credentials must point to the authenticated storage prefix', () => {
  const start = functionsSource.indexOf('exports.registerPassengerProfile');
  const end = functionsSource.indexOf('exports.migratePassengerAccount', start);
  const handler = functionsSource.slice(start, end);

  assert.match(handler, /isOwnedPassengerCredentialUrl\(credentialPhotoUrl, user\.uid\)/);
});

test('only dashboard admins can read passenger credentials or driver documents', () => {
  const adminChecks = storageRules.match(/dashboardAdmin == true/g) || [];
  assert.equal(adminChecks.length, 5);
  assert.doesNotMatch(storageRules, /dashboardRole != 'COORDINATOR'/);
});
