import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildAvailableDriverQuery, createApp, driverAccountDeletionBlocked, isDashboardCoordinator, staleDriverOutcome, validateVehicleCapacity } from '../src/app.js';

async function request(server, path) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
  });
}

async function optionsRequest(server, path, headers) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'OPTIONS', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('health reports a configured dependency-free local service', async () => {
  const server = createApp({ health: async () => ({ configured: false, reachable: false }) });
  const response = await request(server, '/health');
  server.close();
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
});

test('meta identifies the VPS core with Firebase retained for identity and push', async () => {
  const server = createApp({ health: async () => ({ configured: false, reachable: false }) });
  const response = await request(server, '/api/v1/meta');
  server.close();
  assert.equal(response.status, 200);
  assert.equal(response.body.migration, 'vps-core-config-firebase-auth-fcm');
  assert.equal(response.body.realtime, 'dashboard-polling');
});

test('unknown routes are JSON 404s', async () => {
  const server = createApp({ health: async () => ({ configured: false, reachable: false }) });
  const response = await request(server, '/missing');
  server.close();
  assert.equal(response.status, 404);
  assert.equal(response.body.error, 'not_found');
});

test('dashboard origin can complete the authorization preflight', async () => {
  const server = createApp({ health: async () => ({ configured: false, reachable: false }) });
  const response = await optionsRequest(server, '/api/v1/dashboard/overview', {
    Origin: 'https://apl.tucomprass.com',
    'Access-Control-Request-Method': 'GET',
    'Access-Control-Request-Headers': 'authorization,content-type',
  });
  server.close();
  assert.equal(response.status, 204);
  assert.equal(response.headers['access-control-allow-origin'], 'https://apl.tucomprass.com');
  assert.match(response.headers['access-control-allow-headers'], /Authorization/i);
});

test('matching orders approved drivers by pickup proximity and keeps seat capacity in SQL', () => {
  const query = buildAvailableDriverQuery('trip-id', 3);
  assert.deepEqual(query.values, ['trip-id', 3]);
  assert.match(query.text, /d\.vehicle_seats\s*>=\s*\$2/);
  assert.match(query.text, /ORDER BY\s+d\.vehicle_seats\s+ASC/);
  assert.match(query.text, /driver_locations l\s+ON l\.driver_id = d\.id/);
  assert.match(query.text, /6371000 \* acos/);
  assert.match(query.text, /FOR UPDATE OF d SKIP LOCKED/);
});

test('vehicle capacity matches the requested passenger range', () => {
  assert.equal(validateVehicleCapacity('Auto', 4), 4);
  assert.throws(() => validateVehicleCapacity('SUV', 1), /compatibles/);
  assert.throws(() => validateVehicleCapacity('Auto', 5), /compatibles/);
});

test('coordinator dispatch is restricted to VPS dashboard coordinator accounts', () => {
  assert.equal(isDashboardCoordinator({ role: 'dashboard', dashboard_role: 'COORDINATOR' }), true);
  assert.equal(isDashboardCoordinator({ role: 'dashboard', dashboard_role: 'ADMIN' }), false);
  assert.equal(isDashboardCoordinator({ role: 'passenger', dashboard_role: 'COORDINATOR' }), false);
});

test('account deletion is blocked while a driver has an active trip', () => {
  assert.equal(driverAccountDeletionBlocked(null, null), false);
  assert.equal(driverAccountDeletionBlocked('trip-id', null), true);
  assert.equal(driverAccountDeletionBlocked(null, 'trip-id'), true);
});

test('a stale heartbeat alerts without ending the active shift', () => {
  assert.deepEqual(staleDriverOutcome('online'), {
    availabilityStatus: 'online',
    alertReason: 'HEARTBEAT',
  });
  assert.equal(staleDriverOutcome('offline'), null);
});

test('heartbeat endpoint is part of the driver contract', async () => {
  const source = await import('node:fs/promises');
  const appSource = await source.readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /\/api\/v1\/drivers\/heartbeat/);
  assert.match(appSource, /async function driverHeartbeat/);
});
