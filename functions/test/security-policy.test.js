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

test('branding builds require the dashboard manager claim', () => {
  const start = functionsSource.indexOf('exports.requestAppBrandingBuild');
  const end = functionsSource.indexOf('exports.getAppBrandingBuild', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const handler = functionsSource.slice(start, end);

  assert.match(handler, /await requireDashboardManager\(req\)/);
  assert.doesNotMatch(handler, /await requireDashboardAdmin\(req\)/);
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

test('passengers can retry an unavailable trip without changing server-owned assignment fields', () => {
  const tripRules = databaseRules.rules.trips.$tripId;

  assert.match(tripRules['.write'], /no_drivers_available.*searching/);
  assert.match(tripRules.requestedAt['.validate'], /no_drivers_available.*searching/);
  assert.match(tripRules['.validate'], /newData\.child\('driverId'\)\.val\(\) == data\.child\('driverId'\)\.val\(\)/);
  assert.match(tripRules['.validate'], /newData\.child\('completedAt'\)\.val\(\) == data\.child\('completedAt'\)\.val\(\)/);
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

test('coordinators cannot read passenger credentials or driver documents', () => {
  const coordinatorExclusions = storageRules.match(
    /dashboardRole != 'COORDINATOR'/g,
  ) || [];

  assert.equal(coordinatorExclusions.length, 2);
});
