// Reemplaza con la configuracion de tu proyecto Firebase
// (Firebase Console > Configuracion del proyecto > Tus apps > SDK setup).
const firebaseConfig = {
  apiKey: "AIzaSyABbcM0za__wtLsRm3amZa9P10OciEgkBY",
  authDomain: "rastreoflota-53052.firebaseapp.com",
  databaseURL: "https://rastreoflota-53052-default-rtdb.firebaseio.com",
  projectId: "rastreoflota-53052",
  storageBucket: "rastreoflota-53052.firebasestorage.app",
  messagingSenderId: "940357757237",
  appId: "1:940357757237:web:c8221722733d347132c47c",
  measurementId: "G-MN64N2R9L6"
};

// Operational data is served by the Contabo VPS. Firebase remains here for
// dashboard identity and FCM/legacy configuration during the migration.
// Keeping the URL in the static runtime config avoids putting any secret in
// the dashboard bundle.
window.vpsApiBaseUrl = 'https://api.tucomprass.com';

firebase.initializeApp(firebaseConfig);
const firebaseAuth = firebase.auth();

function createVpsDashboardAuth() {
  const sessionKey = 'apl_vps_dashboard_session';
  let current = null;
  const listeners = new Set();
  const makeLegacyUser = (user) => ({
    uid: user.uid,
    email: user.email || '',
    displayName: user.displayName || '',
    getIdToken: () => user.getIdToken(),
    getIdTokenResult: (forceRefresh = false) => user.getIdTokenResult(forceRefresh),
  });
  const readStored = () => {
    try {
      const value = JSON.parse(localStorage.getItem(sessionKey) || 'null');
      if (!value?.token || !value?.user?.id) return null;
      return value;
    } catch (_) { return null; }
  };
  const claimsFor = (user) => {
    const role = String(user.dashboardRole || 'SUPERVISOR').toUpperCase();
    return {
      dashboardUser: true,
      dashboardAdmin: role === 'ADMIN',
      dashboardRole: role,
      sedeId: user.sedeId || '',
      sedeType: user.sedeType || '',
      sedeName: user.sedeName || '',
      sedeAddress: user.sedeAddress || '',
      sedeLat: user.sedeLat == null ? null : Number(user.sedeLat),
      sedeLng: user.sedeLng == null ? null : Number(user.sedeLng),
      email: user.email || '',
      name: user.displayName || '',
    };
  };
  const makeUser = (session) => ({
    uid: session.user.id,
    isVpsSession: true,
    email: session.user.email || '',
    displayName: session.user.displayName || '',
    getIdToken: async () => session.token,
    getIdTokenResult: async () => ({ token: session.token, claims: claimsFor(session.user) }),
  });
  const notify = () => listeners.forEach((listener) => listener(current));
  const setSession = (session) => {
    current = session ? makeUser(session) : null;
    if (session) localStorage.setItem(sessionKey, JSON.stringify(session));
    else localStorage.removeItem(sessionKey);
    notify();
  };
  const stored = readStored();
  if (stored) {
    current = makeUser(stored);
    // A session created before the coordinator place fields were added can
    // still be valid but lack sedeName/coordinates in localStorage. Refresh
    // the public user from the VPS so the coordinator panel can initialize
    // its origin and map without requiring a new login.
    queueMicrotask(async () => {
      try {
        const response = await fetch(`${window.vpsApiBaseUrl}/api/v1/auth/me`, {
          headers: { Authorization: `Bearer ${stored.token}`, Accept: 'application/json' },
          cache: 'no-store',
          signal: AbortSignal.timeout(10000),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.user?.id) return;
        setSession({ ...stored, user: { ...stored.user, ...payload.user } });
      } catch (_) {
        // Keep the cached session usable during a brief network interruption.
      }
    });
  }
  firebaseAuth.onAuthStateChanged((user) => {
    if (current || !user) return;
    current = makeLegacyUser(user);
    notify();
  });
  return {
    get currentUser() { return current; },
    onAuthStateChanged(listener) {
      listeners.add(listener);
      queueMicrotask(() => listener(current));
      return () => listeners.delete(listener);
    },
    async signInWithEmailAndPassword(email, password) {
      const response = await fetch(`${window.vpsApiBaseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: String(email || '').trim().toLowerCase(), password }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) {
          const legacy = await firebaseAuth.signInWithEmailAndPassword(email, password);
          current = makeLegacyUser(legacy.user);
          notify();
          return { user: current };
        }
        const error = new Error(payload.message || payload.error || 'Credenciales inválidas.');
        error.code = response.status === 401 ? 'auth/invalid-credential' : 'auth/network-request-failed';
        throw error;
      }
      if (payload.user?.role !== 'dashboard' || !payload.token) {
        const error = new Error('Esta cuenta no tiene un rol de Dashboard asignado.');
        error.code = 'dashboard/not-authorized';
        throw error;
      }
      const session = { token: payload.token, user: payload.user };
      setSession(session);
      return { user: current };
    },
    async sendPasswordResetEmail(email) {
      const response = await fetch(`${window.vpsApiBaseUrl}/api/v1/auth/request-password-reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: String(email || '').trim().toLowerCase() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload.message || payload.error || 'No se pudo enviar el correo de recuperación.');
        error.code = response.status >= 500 ? 'auth/network-request-failed' : 'auth/password-reset-unavailable';
        throw error;
      }
    },
    async signOut() { setSession(null); await firebaseAuth.signOut(); },
  };
}

const auth = window.vpsApiBaseUrl ? createVpsDashboardAuth() : firebaseAuth;
const db = firebase.database();
const storage = firebase.storage();
