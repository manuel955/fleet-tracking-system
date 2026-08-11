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

test('health reports a configured dependency-free local service', async () => {
  const server = createApp({ health: async () => ({ configured: false, reachable: false }) });
  const response = await request(server, '/health');
  server.close();
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
});

test('meta identifies the parallel migration without changing Firebase clients', async () => {
  const server = createApp({ health: async () => ({ configured: false, reachable: false }) });
  const response = await request(server, '/api/v1/meta');
  server.close();
  assert.equal(response.status, 200);
  assert.equal(response.body.migration, 'firebase-parallel');
});

test('unknown routes are JSON 404s', async () => {
  const server = createApp({ health: async () => ({ configured: false, reachable: false }) });
  const response = await request(server, '/missing');
  server.close();
  assert.equal(response.status, 404);
  assert.equal(response.body.error, 'not_found');
});
