// Small client for the public configuration that now lives in PostgreSQL on
// the VPS. Dashboard authentication still comes from Firebase for now; the
// authenticated helper lets the settings screens dual-write during migration.
(function exposeVpsConfig(global) {
  const base = () => String(global.vpsApiBaseUrl || '').replace(/\/$/, '');

  async function publicConfig() {
    const root = base();
    if (!root) return null;
    const response = await fetch(`${root}/api/v1/public/config`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`VPS config ${response.status}`);
    return response.json();
  }

  async function request(path, { token, method = 'GET', body } = {}) {
    const root = base();
    if (!root) throw new Error('API VPS no configurada.');
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${root}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || payload.error || `VPS ${response.status}`);
    return payload;
  }

  async function uploadFile(key, file, token, onProgress) {
    if (!file || typeof file.arrayBuffer !== 'function') throw new Error('Selecciona un archivo válido.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const chunkSize = 0x8000;
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, bytes.length);
      binary += String.fromCharCode(...bytes.subarray(offset, end));
      if (onProgress) onProgress(Math.round((end / bytes.length) * 100));
    }
    return request('/api/v1/storage/upload', {
      token,
      method: 'POST',
      body: { key, contentType: file.type || 'application/octet-stream', dataBase64: btoa(binary) },
    });
  }

  async function assignDriverPlace(driverId, place, token) {
    return request(`/api/v1/dashboard/drivers/${encodeURIComponent(driverId)}/place`, {
      token,
      method: 'POST',
      body: { type: place.type, name: place.name },
    });
  }

  async function manageDriver(driverId, payload, token) {
    const body = { ...payload };
    delete body.driverId;
    return request(`/api/v1/dashboard/drivers/${encodeURIComponent(driverId)}/manage`, {
      token,
      method: 'POST',
      body,
    });
  }

  global.vpsConfigApi = Object.freeze({ publicConfig, request, uploadFile, assignDriverPlace, manageDriver });
})(typeof globalThis !== 'undefined' ? globalThis : window);
