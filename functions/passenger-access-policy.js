'use strict';

function passengerAccessIsActive(access, now = Date.now()) {
  if (!access || access.status !== 'authorized') return false;
  if (access.legacy === true) return true;
  return Number(access.expiresAt || 0) > now;
}

function passengerAccessPayload(access, source = 'invite', now = Date.now()) {
  const hotelLat = Number(access.hotelLat);
  const hotelLng = Number(access.hotelLng);
  return {
    status: 'authorized',
    source,
    hotelId: String(access.hotelId || ''),
    hotelName: String(access.hotelName || ''),
    hotelAddress: String(access.hotelAddress || ''),
    hotelLat: Number.isFinite(hotelLat) ? hotelLat : null,
    hotelLng: Number.isFinite(hotelLng) ? hotelLng : null,
    grantedAt: Number(access.grantedAt || now),
    expiresAt: Number(access.expiresAt || 0),
    legacy: source === 'legacy',
    inviteHash: access.inviteHash || null,
  };
}

function revokePassengerAccess(access, inviteHash, actorUid, now = Date.now()) {
  if (!access || access.inviteHash !== inviteHash || access.status !== 'authorized') {
    return undefined;
  }
  return {
    ...access,
    status: 'revoked',
    revokedAt: now,
    revokedBy: actorUid || '',
  };
}

function canMigrateLegacyPassengerAccess(access, registeredAt, cutoffMs) {
  const createdAt = Number(registeredAt || 0);
  return !access && createdAt > 0 && createdAt < cutoffMs;
}

module.exports = {
  canMigrateLegacyPassengerAccess,
  passengerAccessIsActive,
  passengerAccessPayload,
  revokePassengerAccess,
};
