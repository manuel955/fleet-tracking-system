const test = require('node:test');
const assert = require('node:assert/strict');

const {
  disconnectReasonLabel,
  isAlertableDisconnectReason,
  normalizeDisconnectReason,
} = require('../alert-policy');

// Regression: ISSUE-003 / ISSUE-007 — every driver disconnection must alert,
// without a schedule or shift-end condition.
// Found by QA on 2026-08-03.
// Report: .gstack/qa-reports/qa-report-86-48-19-189-2026-08-03.md
test('all supported disconnection causes are alertable', () => {
  for (const reason of ['MANUAL', 'HEARTBEAT', 'ADMIN']) {
    assert.equal(isAlertableDisconnectReason(reason), true);
    assert.equal(normalizeDisconnectReason({ ultimo_motivo_desconexion: reason }), reason);
  }
});

test('unknown or missing causes are safely treated as manual', () => {
  assert.equal(normalizeDisconnectReason({}), 'MANUAL');
  assert.equal(normalizeDisconnectReason({ ultimo_motivo_desconexion: 'UNKNOWN' }), 'MANUAL');
  assert.equal(isAlertableDisconnectReason('UNKNOWN'), false);
});

test('alert labels do not depend on a schedule', () => {
  assert.equal(disconnectReasonLabel('MANUAL'), 'Desconexión manual');
  assert.equal(disconnectReasonLabel('HEARTBEAT'), 'Pérdida de señal / heartbeat');
  assert.equal(disconnectReasonLabel('ADMIN'), 'Desconexión administrativa');
});
