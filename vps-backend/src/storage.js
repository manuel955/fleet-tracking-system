import { createHash, createHmac } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from './config.js';
import { pool } from './db.js';

const client = config.s3Endpoint && config.s3Bucket && config.s3AccessKey && config.s3SecretKey
  ? new S3Client({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey },
  })
  : null;

const MAX_PUBLIC_BYTES = 120 * 1024 * 1024;
const MAX_PRIVATE_BYTES = 8 * 1024 * 1024;
const PUBLIC_PREFIXES = ['app_releases/', 'app_branding/', 'dashboard_branding/'];
const DASHBOARD_PREFIXES = PUBLIC_PREFIXES;

export function storageConfigured() {
  return Boolean(client);
}

export function publicStorageUrl(key) {
  return `${config.publicApiBaseUrl}/api/v1/storage/public/${encodeURIComponent(key)}`;
}

export function privateStorageUrl(key) {
  return `${config.publicApiBaseUrl}/api/v1/storage/download/${encodeURIComponent(key)}`;
}

function accessTokenPayload(key, expiresAt) {
  return Buffer.from(JSON.stringify({ key, exp: expiresAt }), 'utf8').toString('base64url');
}

function accessTokenSignature(payload) {
  return createHmac('sha256', config.jwtSecret).update(payload).digest('base64url');
}

export function createPrivateStorageAccessUrl(key, expiresInSeconds = 300) {
  const normalized = normalizeStorageKey(key);
  const exp = Math.floor(Date.now() / 1000) + Math.max(30, Math.min(expiresInSeconds, 3600));
  const payload = accessTokenPayload(normalized, exp);
  const token = `${payload}.${accessTokenSignature(payload)}`;
  return `${config.publicApiBaseUrl}/api/v1/storage/token/${encodeURIComponent(normalized)}?token=${encodeURIComponent(token)}`;
}

export function verifyPrivateStorageAccessToken(key, token) {
  const normalized = normalizeStorageKey(key);
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature || signature !== accessTokenSignature(payload)) return false;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return value.key === normalized && Number(value.exp) > Math.floor(Date.now() / 1000);
  } catch (_) {
    return false;
  }
}

function storageError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function normalizeStorageKey(value) {
  const key = String(value ?? '').trim().replace(/^\/+/, '');
  if (!key || key.length > 240 || key.includes('..') || key.includes('\\') || /[\u0000-\u001f]/.test(key)) {
    throw storageError('Clave de archivo invÃ¡lida.');
  }
  return key;
}

function isPrefix(key, prefixes) {
  return prefixes.some((prefix) => key.startsWith(prefix));
}

function assertAllowedUpload(user, key) {
  if (user.role === 'dashboard') {
    if (!isPrefix(key, DASHBOARD_PREFIXES)) throw storageError('Ruta de archivo no permitida.', 403);
    return;
  }
  if (user.role === 'driver' && key.startsWith(`driver_documents/${user.id}/`)) return;
  if (user.role === 'passenger' && key.startsWith(`passenger_credentials/${user.id}/`)) return;
  throw storageError('No tienes permiso para subir este archivo.', 403);
}

function assertConfigured() {
  if (!client) throw storageError('Almacenamiento del VPS no configurado.', 503);
}

export async function uploadStorageObject(user, body) {
  assertConfigured();
  if (!user) throw storageError('SesiÃ³n requerida.', 401);
  const key = normalizeStorageKey(body.key);
  assertAllowedUpload(user, key);
  const maxBytes = isPublicStorageKey(key) ? MAX_PUBLIC_BYTES : MAX_PRIVATE_BYTES;
  const contentType = String(body.contentType || 'application/octet-stream').slice(0, 160);
  const encoded = String(body.dataBase64 || '');
  if (!encoded || encoded.length > Math.ceil(maxBytes * 4 / 3) + 16) {
    throw storageError('Archivo ausente o demasiado grande.', 413);
  }
  let data;
  try { data = Buffer.from(encoded, 'base64'); } catch (_) { throw storageError('Contenido base64 invÃ¡lido.'); }
  if (!data.length || data.length > maxBytes) throw storageError('Archivo ausente o demasiado grande.', 413);
  const sha256 = createHash('sha256').update(data).digest('hex');
  await client.send(new PutObjectCommand({
    Bucket: config.s3Bucket,
    Key: key,
    Body: data,
    ContentType: contentType,
    CacheControl: isPrefix(key, PUBLIC_PREFIXES) ? 'public, max-age=300' : 'private, max-age=60',
  }));
  if (pool) {
    await pool.query(
      `INSERT INTO storage_objects (object_key, owner_id, purpose, content_type, size_bytes, sha256, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (object_key) DO UPDATE SET owner_id=EXCLUDED.owner_id, purpose=EXCLUDED.purpose,
         content_type=EXCLUDED.content_type, size_bytes=EXCLUDED.size_bytes, sha256=EXCLUDED.sha256, updated_at=now()`,
      [key, user.id, key.split('/')[0], contentType, data.length, sha256],
    );
  }
  return {
    key,
    size: data.length,
    sha256,
    contentType,
    url: isPrefix(key, PUBLIC_PREFIXES) ? publicStorageUrl(key) : privateStorageUrl(key),
    public: isPrefix(key, PUBLIC_PREFIXES),
  };
}

export async function getStorageObject(key) {
  assertConfigured();
  const normalized = normalizeStorageKey(key);
  const result = await client.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: normalized }));
  return { ...result, key: normalized };
}

export async function deletePrivateObjectsForOwner(ownerId) {
  if (!client || !pool) return 0;
  const result = await pool.query(
    `SELECT object_key FROM storage_objects WHERE owner_id=$1 AND object_key LIKE $2`,
    [ownerId, `passenger_credentials/${ownerId}/%`],
  );
  for (const row of result.rows) {
    await client.send(new DeleteObjectCommand({ Bucket: config.s3Bucket, Key: row.object_key }));
  }
  if (result.rowCount) {
    await pool.query('DELETE FROM storage_objects WHERE owner_id=$1 AND object_key LIKE $2', [ownerId, `passenger_credentials/${ownerId}/%`]);
  }
  return result.rowCount || 0;
}

export function isPublicStorageKey(key) {
  return isPrefix(key, PUBLIC_PREFIXES);
}

export async function authorizePrivateDownload(user, key) {
  if (!user) throw storageError('SesiÃ³n requerida.', 401);
  if (user.role === 'dashboard') return;
  if (user.role === 'driver' && key.startsWith(`driver_documents/${user.id}/`)) return;
  if (user.role === 'passenger' && key.startsWith(`passenger_credentials/${user.id}/`)) return;
  if (user.role === 'dashboard') return;
  throw storageError('No tienes permiso para descargar este archivo.', 403);
}
