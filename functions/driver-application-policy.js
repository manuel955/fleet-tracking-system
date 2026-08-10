'use strict';

const VEHICLE_PASSENGER_RANGES = {
  Auto: [1, 4],
  SUV: [5, 7],
  'Mini van': [8, 17],
  Van: [18, 20],
  'Mini bus': [21, 38],
  Bus: [39, 45],
};

const VEHICLE_COLORS = new Set(['Negro', 'Gris', 'Plata', 'Blanco']);
const REQUIRED_DRIVER_DOCUMENTS = [
  { key: 'profile', label: 'foto de perfil', fields: ['profilePhotoUrl'] },
  {
    key: 'dni',
    label: 'DNI',
    alternatives: [['dniDocUrl'], ['dniFrontDocUrl', 'dniBackDocUrl']],
  },
  { key: 'license', label: 'licencia de conducir', fields: ['licenseDocUrl'], expiresField: 'licenseExpiresAt' },
  { key: 'soat', label: 'SOAT', fields: ['soatDocUrl'], expiresField: 'soatExpiresAt' },
  { key: 'circulationCard', label: 'tarjeta de circulación', fields: ['circulationCardDocUrl'] },
  {
    key: 'technicalReview',
    label: 'revisión técnica',
    fields: ['technicalReviewDocUrl'],
    expiresField: 'technicalReviewExpiresAt',
  },
  { key: 'criminalRecord', label: 'récord del conductor', fields: ['criminalRecordDocUrl'] },
  { key: 'workCertificate', label: 'certificado laboral', fields: ['workCertificateDocUrl'] },
];

function normalizedText(value) {
  return String(value || '').trim();
}

function isOwnedDriverDocumentUrl(rawValue, uid, bucket) {
  try {
    const url = new URL(normalizedText(rawValue));
    const expectedPrefix = `/v0/b/${bucket}/o/driver_documents/${uid}/`;
    return url.protocol === 'https:'
      && url.hostname === 'firebasestorage.googleapis.com'
      && decodeURIComponent(url.pathname).startsWith(expectedPrefix)
      && url.searchParams.get('alt') === 'media'
      && Boolean(url.searchParams.get('token'));
  } catch (_) {
    return false;
  }
}

function validVehicleData(vehicleType, vehicleColor, vehicleSeats) {
  const range = VEHICLE_PASSENGER_RANGES[vehicleType];
  const seats = Number(vehicleSeats);
  return Boolean(
    range
      && VEHICLE_COLORS.has(vehicleColor)
      && Number.isInteger(seats)
      && seats >= range[0]
      && seats <= range[1],
  );
}

function validDocumentAlternative(application, fields, uid, bucket) {
  return fields.every((field) => isOwnedDriverDocumentUrl(application[field], uid, bucket));
}

function driverApplicationIssues(application, uid, bucket, now = Date.now()) {
  const issues = [];
  const email = normalizedText(application?.email);
  const name = normalizedText(application?.name);
  const age = Number(application?.age);
  const phone = normalizedText(application?.phone);
  const dni = normalizedText(application?.dni);
  const plate = normalizedText(application?.plate);
  const vehicleBrand = normalizedText(application?.vehicleBrand);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) issues.push('correo válido');
  if (name.length < 2 || name.length > 120) issues.push('nombre completo');
  if (!Number.isInteger(age) || age < 18 || age > 99) issues.push('edad válida');
  if (!/^\+\d{8,19}$/.test(phone)) issues.push('teléfono con prefijo internacional');
  if (dni.length < 6 || dni.length > 20) issues.push('número de DNI');
  if (plate.length < 4 || plate.length > 12) issues.push('placa');
  if (vehicleBrand.length < 2 || vehicleBrand.length > 60) issues.push('marca del vehículo');
  if (!validVehicleData(application?.vehicleType, application?.vehicleColor, application?.vehicleSeats)) {
    issues.push('tipo, color y capacidad del vehículo');
  }

  for (const document of REQUIRED_DRIVER_DOCUMENTS) {
    const alternatives = document.alternatives || [document.fields];
    if (!alternatives.some((fields) => validDocumentAlternative(application, fields, uid, bucket))) {
      issues.push(document.label);
    }
    if (document.expiresField) {
      const expiresAt = Number(application?.[document.expiresField]);
      if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        issues.push(`vencimiento vigente de ${document.label}`);
      }
    }
  }

  return [...new Set(issues)];
}

module.exports = {
  REQUIRED_DRIVER_DOCUMENTS,
  VEHICLE_COLORS,
  VEHICLE_PASSENGER_RANGES,
  driverApplicationIssues,
  isOwnedDriverDocumentUrl,
  validVehicleData,
};
