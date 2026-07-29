#!/usr/bin/env node
'use strict';

// Prueba de carga: simula solicitudes de pasajeros continuas (por defecto
// 100, cada 10-15s) contra el proyecto Firebase REAL (rastreoflota-53052).
// Cada viaje se crea con status 'searching' -- exactamente igual que
// passenger-app -- para que la Cloud Function real `assignDriverOnTripCreate`
// (functions/matching.js) lo asigne solo, sin ningun cambio en el backend.
//
// Para tener "100 conductores" disponibles se crean conductores simulados
// (drivers/sim_driver_*) en estado 'online'. Los conductores reales que ya
// existan en el sistema se excluyen de la asignacion via `rejectedDriverIds`
// (mecanismo que matching.js ya respeta), asi ningun telefono real recibe
// un viaje falso.
//
// Todo lo que este script crea (drivers, trips, tripHistory, historial de
// conexion) se borra al terminar -- incluyendo si se corta con Ctrl+C o si
// truena a medio camino. Si aun asi el proceso muere de forma abrupta, el
// archivo manifest-<RUN_ID>.json (guardado en esta misma carpeta) permite
// limpiar despues a mano:
//
//   node simulate.js --cleanup manifest-<RUN_ID>.json
//
// Uso:
//   node simulate.js            # 100 viajes, 10-15s de separacion
//   node simulate.js --n 5      # prueba corta (smoke test)

const path = require('path');
const fs = require('fs');

const FLEET_ROOT = path.resolve(__dirname, '..', '..');
const PROJECT_ROOT = path.resolve(FLEET_ROOT, '..');
const KEY_PATH = path.join(
  PROJECT_ROOT,
  'rastreoflota-53052-firebase-adminsdk-fbsvc-c3d039668f.json'
);
const DB_URL = 'https://rastreoflota-53052-default-rtdb.firebaseio.com';

if (!fs.existsSync(KEY_PATH)) {
  console.error(`No encuentro la credencial de Firebase Admin en: ${KEY_PATH}`);
  process.exit(1);
}
process.env.GOOGLE_APPLICATION_CREDENTIALS = KEY_PATH;

const admin = require(path.join(FLEET_ROOT, 'functions', 'node_modules', 'firebase-admin'));

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: DB_URL,
});
const db = admin.database();

function argValue(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const NUM_TRIPS = Number(argValue('--n', 100));
const MIN_GAP_MS = 10_000;
const MAX_GAP_MS = 15_000;
const HUB = { lat: -12.0464, lng: -77.0428 }; // punto ficticio de referencia

const RUN_ID = Date.now();
const MANIFEST_PATH = path.join(__dirname, `manifest-${RUN_ID}.json`);
const manifest = { drivers: [], trips: [] };
function saveManifest() {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

function jitter(base, deg = 0.01) {
  return base + (Math.random() * 2 - 1) * deg;
}
function rand(min, max) {
  return min + Math.random() * (max - min);
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getExistingDriverIds() {
  const snap = await db.ref('drivers').once('value');
  const ids = [];
  snap.forEach((child) => ids.push(child.key));
  return ids;
}

async function createFakeDrivers(n) {
  const updates = {};
  const ids = [];
  for (let i = 1; i <= n; i++) {
    const id = `sim_driver_${RUN_ID}_${i}`;
    ids.push(id);
    updates[id] = {
      name: `Conductor simulado ${i}`,
      phone: `+51900${String(i).padStart(6, '0')}`,
      plate: `SIM-${String(i).padStart(3, '0')}`,
      status: 'online',
      lat: jitter(HUB.lat),
      lng: jitter(HUB.lng),
      lastUpdate: Date.now(),
    };
  }
  await db.ref('drivers').update(updates);
  manifest.drivers.push(...ids);
  saveManifest();
}

async function moveDriver(driverId, from, to, steps, totalMs) {
  const stepMs = totalMs / steps;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    await db.ref(`drivers/${driverId}`).update({
      lat: lerp(from.lat, to.lat, t),
      lng: lerp(from.lng, to.lng, t),
      lastUpdate: Date.now(),
    });
    await sleep(stepMs);
  }
}

async function waitForAssignment(tripId, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = await db.ref(`trips/${tripId}`).once('value');
    const trip = snap.val();
    if (!trip) throw new Error('el viaje desaparecio mientras esperaba asignacion');
    if (trip.status === 'accepted' && trip.driverId) return trip;
    if (trip.status === 'no_drivers_available') return trip;
    await sleep(500);
  }
  throw new Error('timeout esperando asignacion (revisar logs de Cloud Functions)');
}

async function runTrip(index, rejectedDriverIds) {
  const pickup = { lat: jitter(HUB.lat), lng: jitter(HUB.lng) };
  const destination = { lat: jitter(HUB.lat, 0.03), lng: jitter(HUB.lng, 0.03) };
  const passengerId = `sim_passenger_${RUN_ID}_${index}`;
  const startedAt = Date.now();

  const ref = db.ref('trips').push();
  const tripId = ref.key;
  manifest.trips.push(tripId);
  saveManifest();

  const result = { index, tripId, outcome: null, driverId: null, ms: {} };

  try {
    await ref.set({
      passengerId,
      passengerName: `Pasajero simulado ${index}`,
      passengerPhone: `+51999${String(index).padStart(6, '0')}`,
      pickupLat: pickup.lat,
      pickupLng: pickup.lng,
      pickupAddress: 'Punto de recojo ficticio (prueba de carga)',
      destinationLat: destination.lat,
      destinationLng: destination.lng,
      destinationAddress: 'Destino ficticio (prueba de carga)',
      status: 'searching',
      requestedAt: startedAt,
      rejectedDriverIds,
    });

    const assigned = await waitForAssignment(tripId);
    if (assigned.status === 'no_drivers_available') {
      result.outcome = 'no_drivers_available';
      return result;
    }
    result.driverId = assigned.driverId;
    result.ms.assignment = Date.now() - startedAt;

    const driverSnap = await db.ref(`drivers/${assigned.driverId}`).once('value');
    const driverPos = driverSnap.val() || pickup;
    await moveDriver(assigned.driverId, driverPos, pickup, 3, rand(15000, 25000));

    await db.ref(`trips/${tripId}`).update({ status: 'arrived_at_pickup', arrivedAt: Date.now() });
    await sleep(rand(2000, 4000));

    await db.ref(`trips/${tripId}`).update({ status: 'in_progress', inProgressAt: Date.now() });
    await moveDriver(assigned.driverId, pickup, destination, 4, rand(20000, 35000));

    await db.ref(`trips/${tripId}`).update({ status: 'completed', completedAt: Date.now() });

    // Deja que handleTripStatusChange (server) libere al conductor y archive
    // el viaje en tripHistory antes de que la limpieza final lo borre.
    await sleep(4000);

    result.outcome = 'completed';
    result.ms.total = Date.now() - startedAt;
  } catch (err) {
    result.outcome = 'error';
    result.error = err.message;
  }
  return result;
}

async function cleanup() {
  const updates = {};
  for (const id of manifest.drivers) {
    updates[`drivers/${id}`] = null;
    updates[`driverConnectionHistory/${id}`] = null;
  }
  for (const id of manifest.trips) {
    updates[`trips/${id}`] = null;
    updates[`tripHistory/${id}`] = null;
  }
  if (Object.keys(updates).length) await db.ref().update(updates);
}

async function cleanupOnly(manifestPath) {
  const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.drivers = data.drivers || [];
  manifest.trips = data.trips || [];
  await cleanup();
  console.log(`Limpieza completada desde ${manifestPath} (${manifest.drivers.length} conductores, ${manifest.trips.length} viajes).`);
}

async function main() {
  console.log(`Prueba de carga: ${NUM_TRIPS} viajes ficticios contra rastreoflota-53052 (produccion real).`);

  const existingDrivers = await getExistingDriverIds();
  console.log(`Conductores reales detectados (excluidos de la asignacion): ${existingDrivers.length}${existingDrivers.length ? ' -> ' + existingDrivers.join(', ') : ''}`);
  const rejectedDriverIds = {};
  existingDrivers.forEach((id) => { rejectedDriverIds[id] = true; });

  await createFakeDrivers(NUM_TRIPS);
  console.log(`${NUM_TRIPS} conductores simulados creados como 'online'.`);

  const results = [];
  const pending = [];
  for (let i = 1; i <= NUM_TRIPS; i++) {
    console.log(`[${i}/${NUM_TRIPS}] creando solicitud de viaje...`);
    pending.push(
      runTrip(i, rejectedDriverIds).then((r) => {
        results.push(r);
        console.log(`  <- viaje ${r.index} (${r.tripId}): ${r.outcome}${r.error ? ' :: ' + r.error : ''}`);
      })
    );
    if (i < NUM_TRIPS) await sleep(rand(MIN_GAP_MS, MAX_GAP_MS));
  }

  console.log('Todas las solicitudes fueron enviadas. Esperando a que los viajes en curso terminen...');
  await Promise.allSettled(pending);

  const summary = {
    total: results.length,
    completed: results.filter((r) => r.outcome === 'completed').length,
    no_drivers_available: results.filter((r) => r.outcome === 'no_drivers_available').length,
    error: results.filter((r) => r.outcome === 'error').length,
  };
  const totalTimes = results.filter((r) => r.ms.total).map((r) => r.ms.total);
  if (totalTimes.length) {
    summary.avgTotalMs = Math.round(totalTimes.reduce((a, b) => a + b, 0) / totalTimes.length);
    summary.minTotalMs = Math.min(...totalTimes);
    summary.maxTotalMs = Math.max(...totalTimes);
  }

  console.log('--- RESUMEN ---');
  console.log(JSON.stringify(summary, null, 2));

  const problems = results.filter((r) => r.outcome !== 'completed');
  if (problems.length) {
    console.log('Detalle de viajes que NO se completaron normalmente:');
    problems.forEach((r) => console.log(`  viaje ${r.index} (${r.tripId}): ${r.outcome} ${r.error || ''}`));
  }
}

(async () => {
  const cleanupIdx = process.argv.indexOf('--cleanup');
  if (cleanupIdx !== -1) {
    await cleanupOnly(process.argv[cleanupIdx + 1]);
    process.exit(0);
  }

  let exitCode = 0;
  process.on('SIGINT', async () => {
    console.log('\nInterrumpido -- limpiando datos simulados antes de salir...');
    try {
      await cleanup();
      console.log('Limpieza completada.');
    } catch (e) {
      console.error('La limpieza fallo:', e.message);
      console.error(`Reintenta con: node simulate.js --cleanup "${MANIFEST_PATH}"`);
    }
    process.exit(130);
  });

  try {
    await main();
  } catch (err) {
    console.error('Error fatal:', err);
    exitCode = 1;
  } finally {
    console.log('Limpiando datos simulados (drivers, viajes, historial)...');
    try {
      await cleanup();
      console.log('Limpieza completada -- no debe quedar ningun registro simulado permanente.');
      if (fs.existsSync(MANIFEST_PATH)) fs.unlinkSync(MANIFEST_PATH);
    } catch (e) {
      console.error('La limpieza automatica fallo:', e.message);
      console.error(`Corre manualmente: node simulate.js --cleanup "${MANIFEST_PATH}"`);
      exitCode = 1;
    }
  }
  process.exit(exitCode);
})();
