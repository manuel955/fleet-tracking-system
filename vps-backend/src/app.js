import http from 'node:http';
import { config } from './config.js';
import { databaseHealth } from './db.js';

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export function createApp({ health = databaseHealth } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/health') {
        const database = await health();
        const healthy = database.reachable || !database.configured;
        return json(res, healthy ? 200 : 503, {
          status: healthy ? 'ok' : 'degraded',
          service: 'apl-logistics-vps-backend',
          database,
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/meta') {
        return json(res, 200, {
          apiVersion: 'v1',
          migration: 'firebase-parallel',
          realtime: 'websocket-pending',
          storage: config.s3Bucket ? 's3-compatible' : 'unconfigured',
        });
      }

      return json(res, 404, { error: 'not_found' });
    } catch (error) {
      return json(res, 503, {
        error: 'service_unavailable',
        message: config.nodeEnv === 'production' ? 'Service unavailable' : error.message,
      });
    }
  });
}
