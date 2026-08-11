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

  global.vpsConfigApi = Object.freeze({ publicConfig, request });
})(typeof globalThis !== 'undefined' ? globalThis : window);
