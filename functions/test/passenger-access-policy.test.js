const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canMigrateLegacyPassengerAccess,
  passengerAccessIsActive,
  passengerAccessPayload,
  revokePassengerAccess,
} = require('../passenger-access-policy');

test('solo considera activo un acceso autorizado y vigente', () => {
  assert.equal(passengerAccessIsActive({ status: 'authorized', expiresAt: 2_000 }, 1_000), true);
  assert.equal(passengerAccessIsActive({ status: 'authorized', expiresAt: 999 }, 1_000), false);
  assert.equal(passengerAccessIsActive({ status: 'revoked', expiresAt: 2_000 }, 1_000), false);
  assert.equal(passengerAccessIsActive({ status: 'authorized', legacy: true }, 1_000), true);
});

test('crea el acceso con datos normalizados y conserva el hash de invitacion', () => {
  const access = passengerAccessPayload({
    hotelId: 'hotel-1',
    hotelLat: '-12.1',
    hotelLng: '-77.1',
    expiresAt: 5_000,
    inviteHash: 'hash-1',
  }, 'invite', 1_000);

  assert.equal(access.status, 'authorized');
  assert.equal(access.grantedAt, 1_000);
  assert.equal(access.hotelLat, -12.1);
  assert.equal(access.inviteHash, 'hash-1');
  assert.equal(access.legacy, false);
});

test('revoca unicamente el acceso que proviene de la invitacion indicada', () => {
  const current = { status: 'authorized', inviteHash: 'hash-1', expiresAt: 5_000 };
  assert.deepEqual(revokePassengerAccess(current, 'hash-1', 'admin-1', 2_000), {
    ...current,
    status: 'revoked',
    revokedAt: 2_000,
    revokedBy: 'admin-1',
  });
  assert.equal(revokePassengerAccess(current, 'hash-2', 'admin-1', 2_000), undefined);
  assert.equal(revokePassengerAccess({ ...current, status: 'revoked' }, 'hash-1', 'admin-1', 2_000), undefined);
});

test('la migracion heredada nunca reactiva un acceso vencido o revocado', () => {
  const cutoff = 5_000;
  assert.equal(canMigrateLegacyPassengerAccess(null, 4_000, cutoff), true);
  assert.equal(canMigrateLegacyPassengerAccess(null, 5_000, cutoff), false);
  assert.equal(canMigrateLegacyPassengerAccess({ status: 'revoked' }, 4_000, cutoff), false);
  assert.equal(canMigrateLegacyPassengerAccess({ status: 'authorized', expiresAt: 1 }, 4_000, cutoff), false);
});
