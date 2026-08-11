import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';

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
  assert.equal(response.body.migration, 'vps-core-firebase-auth-fcm');
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
