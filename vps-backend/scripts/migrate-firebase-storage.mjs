import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import pg from 'pg';

const bucket = process.env.FIREBASE_STORAGE_BUCKET || 'rastreoflota-53052.firebasestorage.app';
const firebaseConfigPath = process.env.FIREBASE_TO_VPS_CONFIG
  || `${homedir()}/.config/configstore/firebase-tools.json`;
const s3 = new S3Client({
  endpoint: process.env.VPS_S3_ENDPOINT || 'http://127.0.0.1:19000',
  region: process.env.VPS_S3_REGION || 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.VPS_S3_ACCESS_KEY || '',
    secretAccessKey: process.env.VPS_S3_SECRET_KEY || '',
  },
});
const pool = process.env.VPS_DB_PASSWORD
  ? new pg.Pool({
    host: process.env.VPS_DB_HOST || '127.0.0.1',
    port: Number(process.env.VPS_DB_PORT || 15432),
    database: process.env.VPS_DB_NAME || 'apl_logistics',
    user: process.env.VPS_DB_USER || 'apl',
    password: process.env.VPS_DB_PASSWORD,
  })
  : null;

function md5Base64(buffer) {
  return createHash('md5').update(buffer).digest('base64');
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function firebaseToken() {
  const config = JSON.parse(await readFile(firebaseConfigPath, 'utf8'));
  const token = config?.tokens?.access_token;
  if (!token) throw new Error(`No hay token de Firebase CLI en ${firebaseConfigPath}`);
  return token;
}

async function listObjects(token) {
  const objects = [];
  let pageToken = '';
  do {
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${bucket}/o`);
    url.searchParams.set('maxResults', '1000');
    url.searchParams.set('fields', 'nextPageToken,items(name,size,md5Hash,contentType,updated)');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const payload = await response.json();
    if (!response.ok) throw new Error(`Firebase list ${response.status}: ${JSON.stringify(payload)}`);
    objects.push(...(payload.items || []));
    pageToken = payload.nextPageToken || '';
  } while (pageToken);
  return objects;
}

async function downloadFirebase(token, name) {
  const url = `https://storage.googleapis.com/download/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}?alt=media`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Firebase download ${name}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function migrate() {
  if (!process.env.VPS_S3_ACCESS_KEY || !process.env.VPS_S3_SECRET_KEY || !process.env.VPS_S3_BUCKET) {
    throw new Error('Faltan VPS_S3_ACCESS_KEY, VPS_S3_SECRET_KEY o VPS_S3_BUCKET.');
  }
  const token = await firebaseToken();
  const objects = await listObjects(token);
  const summary = { total: objects.length, copied: 0, skipped: 0, bytes: 0, failures: [] };
  console.log(`Firebase Storage: ${objects.length} objetos, ${objects.reduce((sum, item) => sum + Number(item.size || 0), 0)} bytes.`);
  for (const item of objects) {
    const expectedSize = Number(item.size || 0);
    try {
      const existing = await s3.send(new HeadObjectCommand({ Bucket: process.env.VPS_S3_BUCKET, Key: item.name }));
      const known = pool
        ? await pool.query('SELECT 1 FROM storage_objects WHERE object_key = $1', [item.name])
        : { rowCount: 0 };
      if (Number(existing.ContentLength || 0) === expectedSize && expectedSize > 0 && known.rowCount) {
        summary.skipped += 1;
        summary.bytes += expectedSize;
        console.log(`SKIP ${item.name}`);
        continue;
      }
    } catch (error) {
      if (error?.$metadata?.httpStatusCode !== 404 && error?.name !== 'NotFound' && error?.name !== 'NoSuchKey') throw error;
    }
    const data = await downloadFirebase(token, item.name);
    if (data.length !== expectedSize || (item.md5Hash && md5Base64(data) !== item.md5Hash)) {
      throw new Error(`Checksum Firebase no coincide para ${item.name}`);
    }
    await s3.send(new PutObjectCommand({
      Bucket: process.env.VPS_S3_BUCKET,
      Key: item.name,
      Body: data,
      ContentType: item.contentType || 'application/octet-stream',
      CacheControl: item.name.startsWith('app_releases/') || item.name.startsWith('app_branding/') || item.name.startsWith('dashboard_branding/')
        ? 'public, max-age=300' : 'private, max-age=60',
    }));
    const copied = await s3.send(new HeadObjectCommand({ Bucket: process.env.VPS_S3_BUCKET, Key: item.name }));
    if (Number(copied.ContentLength || 0) !== data.length) throw new Error(`Tamaño VPS no coincide para ${item.name}`);
    if (pool) {
      await pool.query(
        `INSERT INTO storage_objects (object_key, purpose, content_type, size_bytes, sha256, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (object_key) DO UPDATE SET purpose=EXCLUDED.purpose, content_type=EXCLUDED.content_type,
           size_bytes=EXCLUDED.size_bytes, sha256=EXCLUDED.sha256, updated_at=now()`,
        [item.name, item.name.split('/')[0], item.contentType || 'application/octet-stream', data.length, sha256Hex(data)],
      );
    }
    summary.copied += 1;
    summary.bytes += data.length;
    console.log(`COPY ${item.name}`);
  }
  console.log(JSON.stringify(summary));
  await pool?.end();
}

migrate().catch(async (error) => {
  await pool?.end();
  console.error(error?.stack || error);
  process.exitCode = 1;
});
