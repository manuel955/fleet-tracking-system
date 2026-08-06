const ALERTABLE_DISCONNECT_REASONS = new Set(['MANUAL', 'HEARTBEAT', 'ADMIN']);

function normalizeDisconnectReason(driver) {
  const reason = String(driver?.ultimo_motivo_desconexion || 'MANUAL');
  return ALERTABLE_DISCONNECT_REASONS.has(reason) ? reason : 'MANUAL';
}

function isAlertableDisconnectReason(reason) {
  return ALERTABLE_DISCONNECT_REASONS.has(reason);
}

function disconnectReasonLabel(reason) {
  if (reason === 'HEARTBEAT') return 'Pérdida de señal / heartbeat';
  if (reason === 'ADMIN') return 'Desconexión administrativa';
  return 'Desconexión manual';
}

module.exports = {
  disconnectReasonLabel,
  isAlertableDisconnectReason,
  normalizeDisconnectReason,
};
