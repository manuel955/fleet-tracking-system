const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require('@firebase/rules-unit-testing');
const { get, ref, set, update } = require('firebase/database');

const emulatorHost = process.env.FIREBASE_DATABASE_EMULATOR_HOST;

if (!emulatorHost) {
  test('Realtime Database rules emulator suite', { skip: 'requires Firebase Database emulator' }, () => {});
} else {
  const separator = emulatorHost.lastIndexOf(':');
  const host = emulatorHost.slice(0, separator);
  const port = Number(emulatorHost.slice(separator + 1));
  const rules = fs.readFileSync(
    path.join(__dirname, '..', '..', 'database', 'firebase-rules.json'),
    'utf8',
  );
  let environment;

  test.before(async () => {
    environment = await initializeTestEnvironment({
      projectId: 'rastreoflota-53052',
      database: { host, port, rules },
    });
  });

  test.beforeEach(async () => {
    await environment.clearDatabase();
  });

  test.after(async () => {
    await environment.cleanup();
  });

  async function seed(pathName, value) {
    await environment.withSecurityRulesDisabled(async (context) => {
      await set(ref(context.database(), pathName), value);
    });
  }

  function driverRegistration() {
    const now = Date.now();
    return {
      email: 'driver@example.com',
      name: 'Driver Test',
      age: 30,
      phone: '+51999999999',
      dni: '12345678',
      plate: 'ABC-123',
      vehicleBrand: 'Toyota',
      vehicleType: 'Auto',
      vehicleColor: 'Negro',
      vehicleSeats: 4,
      approvalStatus: 'pending_review',
      registeredAt: now,
      documentsSubmittedAt: now,
    };
  }

  function passengerTrip(overrides = {}) {
    return {
      passengerId: 'passenger-1',
      passengerName: 'Passenger Test',
      passengerCount: 1,
      pickupLat: -12.05,
      pickupLng: -77.04,
      pickupAddress: 'Origen',
      destinationLat: -12.06,
      destinationLng: -77.05,
      destinationAddress: 'Destino',
      status: 'searching',
      requestedAt: Date.now(),
      ...overrides,
    };
  }

  test('a driver can create the initial profile but cannot bypass server-owned state', async () => {
    const context = environment.authenticatedContext('driver-1');
    const profileRef = ref(context.database(), 'drivers/driver-1');

    await assertSucceeds(set(profileRef, driverRegistration()));
    await assertFails(update(profileRef, { phone: '+51888888888' }));
    await assertFails(update(profileRef, { lat: -12.05, lng: -77.04, lastUpdate: Date.now() }));
    await assertFails(update(profileRef, { turno_activo: true }));
    await assertFails(set(ref(context.database(), 'driverLocations/driver-1/lat'), -12.05));
  });

  test('only an administrator can approve a driver', async () => {
    await seed('drivers/driver-1', driverRegistration());
    const admin = environment.authenticatedContext('admin-1', {
      dashboardUser: true,
      dashboardAdmin: true,
      dashboardRole: 'ADMIN',
    });
    const supervisor = environment.authenticatedContext('supervisor-1', {
      dashboardUser: true,
      dashboardAdmin: false,
      dashboardRole: 'SUPERVISOR',
    });
    const coordinator = environment.authenticatedContext('coordinator-1', {
      dashboardUser: true,
      dashboardAdmin: false,
      dashboardRole: 'COORDINATOR',
    });
    const changes = {
      approvalStatus: 'approved',
      reviewedAt: Date.now(),
      reviewedBy: 'admin@example.com',
    };

    await assertFails(update(ref(supervisor.database(), 'drivers/driver-1'), changes));
    await assertFails(update(ref(coordinator.database(), 'drivers/driver-1'), changes));
    await assertSucceeds(update(ref(admin.database(), 'drivers/driver-1'), changes));
  });

  test('a passenger can retry an unavailable trip without changing its assignment', async () => {
    await seed('passengerAccess/passenger-1', { status: 'authorized', legacy: true });
    await seed('trips/trip-1', {
      passengerId: 'passenger-1',
      passengerName: 'Passenger Test',
      passengerCount: 1,
      pickupLat: -12.05,
      pickupLng: -77.04,
      pickupAddress: 'Origen',
      destinationLat: -12.06,
      destinationLng: -77.05,
      destinationAddress: 'Destino',
      status: 'no_drivers_available',
      requestedAt: 1,
      noDriversReason: 'Sin conductores',
    });
    const passenger = environment.authenticatedContext('passenger-1');
    const tripRef = ref(passenger.database(), 'trips/trip-1');

    await assertSucceeds(update(tripRef, {
      status: 'searching',
      requestedAt: Date.now(),
      noDriversReason: null,
    }));
    await assertFails(update(tripRef, { driverId: 'driver-2' }));
    await assertFails(update(tripRef, { acceptedAt: Date.now() }));
  });

  test('a passenger cannot inject server assignment fields when creating a trip', async () => {
    await seed('passengerAccess/passenger-1', { status: 'authorized', legacy: true });
    const passenger = environment.authenticatedContext('passenger-1');
    const trip = passengerTrip({
      driverId: 'driver-injected',
    });

    await assertFails(set(ref(passenger.database(), 'trips/trip-injected'), trip));
    delete trip.driverId;
    await assertSucceeds(set(ref(passenger.database(), 'trips/trip-valid'), trip));
  });

  test('driver location reads require the assigned passenger, driver, or a non-coordinator dashboard role', async () => {
    await seed('drivers/driver-1', {
      ...driverRegistration(),
      approvalStatus: 'approved',
      currentTripId: 'trip-1',
    });
    await seed('trips/trip-1', {
      passengerId: 'passenger-1',
      driverId: 'driver-1',
      status: 'accepted',
    });
    await seed('driverLocations/driver-1', {
      lat: -12.05,
      lng: -77.04,
      heading: 90,
      lastUpdate: Date.now(),
    });
    const passenger = environment.authenticatedContext('passenger-1');
    const otherPassenger = environment.authenticatedContext('passenger-2');
    const driver = environment.authenticatedContext('driver-1');
    const supervisor = environment.authenticatedContext('supervisor-1', {
      dashboardUser: true,
      dashboardRole: 'SUPERVISOR',
    });
    const coordinator = environment.authenticatedContext('coordinator-1', {
      dashboardUser: true,
      dashboardRole: 'COORDINATOR',
    });
    const locationPath = 'driverLocations/driver-1';

    await assertSucceeds(get(ref(passenger.database(), locationPath)));
    await assertSucceeds(get(ref(driver.database(), locationPath)));
    await assertSucceeds(get(ref(supervisor.database(), locationPath)));
    await assertFails(get(ref(otherPassenger.database(), locationPath)));
    await assertFails(get(ref(coordinator.database(), locationPath)));
  });

  test('expired or blocked passenger access cannot create trips', async () => {
    await seed('passengerAccess/passenger-active', {
      status: 'authorized', legacy: false, expiresAt: Date.now() + 60_000,
    });
    await seed('passengerAccess/passenger-expired', {
      status: 'authorized', legacy: false, expiresAt: Date.now() - 60_000,
    });
    await seed('passengerAccess/passenger-blocked', {
      status: 'blocked', legacy: true,
    });
    const active = environment.authenticatedContext('passenger-active');
    const expired = environment.authenticatedContext('passenger-expired');
    const blocked = environment.authenticatedContext('passenger-blocked');
    const activeTrip = passengerTrip({ passengerId: 'passenger-active' });
    const expiredTrip = passengerTrip({ passengerId: 'passenger-expired' });
    const blockedTrip = passengerTrip({ passengerId: 'passenger-blocked' });

    await assertSucceeds(set(ref(active.database(), 'trips/trip-active'), activeTrip));
    await assertFails(set(ref(expired.database(), 'trips/trip-expired'), expiredTrip));
    await assertFails(set(ref(blocked.database(), 'trips/trip-blocked'), blockedTrip));
  });

  test('terminal trips cannot be edited and their driver location is no longer exposed', async () => {
    await seed('trips/trip-completed', passengerTrip({
      status: 'completed',
      driverId: 'driver-1',
      completedAt: Date.now(),
    }));
    await seed('drivers/driver-1', {
      ...driverRegistration(),
      approvalStatus: 'approved',
      currentTripId: 'trip-completed',
    });
    await seed('driverLocations/driver-1', {
      lat: -12.05, lng: -77.04, heading: 90, lastUpdate: Date.now(),
    });
    const passenger = environment.authenticatedContext('passenger-1');

    await assertFails(update(ref(passenger.database(), 'trips/trip-completed'), {
      destinationAddress: 'Destino alterado',
    }));
    await assertFails(update(ref(passenger.database(), 'trips/trip-completed'), {
      status: 'searching',
    }));
    await assertFails(get(ref(passenger.database(), 'driverLocations/driver-1')));
  });

  test('history and operational alerts remain scoped to owners and administrators', async () => {
    await seed('tripHistory/trip-1', { driverId: 'driver-1', status: 'completed' });
    await seed('driverTripHistory/driver-1/trip-1', {
      driverId: 'driver-1', status: 'completed',
    });
    await seed('prematureDisconnectAlerts/alert-1', { driverId: 'driver-1', status: 'OPEN' });
    const driver = environment.authenticatedContext('driver-1');
    const otherDriver = environment.authenticatedContext('driver-2');
    const admin = environment.authenticatedContext('admin-1', {
      dashboardUser: true,
      dashboardAdmin: true,
      dashboardRole: 'ADMIN',
    });
    const supervisor = environment.authenticatedContext('supervisor-1', {
      dashboardUser: true,
      dashboardAdmin: false,
      dashboardRole: 'SUPERVISOR',
    });

    await assertSucceeds(get(ref(driver.database(), 'driverTripHistory/driver-1')));
    await assertFails(get(ref(otherDriver.database(), 'driverTripHistory/driver-1')));
    await assertSucceeds(get(ref(admin.database(), 'tripHistory')));
    await assertSucceeds(get(ref(admin.database(), 'prematureDisconnectAlerts')));
    await assertFails(get(ref(supervisor.database(), 'tripHistory')));
    await assertFails(get(ref(supervisor.database(), 'prematureDisconnectAlerts')));
  });

  test('coordinators only read their private trip mirror', async () => {
    await seed('coordinatorTrips/coordinator-1/trip-1', {
      dispatcherUid: 'coordinator-1',
      pickupAddress: 'Origen',
      destinationAddress: 'Destino',
      status: 'accepted',
      requestedAt: Date.now(),
    });
    await seed('trips/trip-1', passengerTrip({ dispatcherUid: 'coordinator-1' }));
    const owner = environment.authenticatedContext('coordinator-1', {
      dashboardUser: true,
      dashboardRole: 'COORDINATOR',
    });
    const other = environment.authenticatedContext('coordinator-2', {
      dashboardUser: true,
      dashboardRole: 'COORDINATOR',
    });

    await assertSucceeds(get(ref(owner.database(), 'coordinatorTrips/coordinator-1')));
    await assertFails(get(ref(other.database(), 'coordinatorTrips/coordinator-1')));
    await assertFails(get(ref(owner.database(), 'trips')));
    await assertFails(update(ref(owner.database(), 'coordinatorTrips/coordinator-1/trip-1'), {
      status: 'cancelled',
    }));
  });

  test('emulator environment was configured', () => {
    assert.equal(Number.isInteger(port), true);
    assert.equal(port > 0, true);
  });
}
