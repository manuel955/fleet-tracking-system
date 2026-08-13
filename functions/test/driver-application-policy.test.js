const test = require('node:test');
const assert = require('node:assert/strict');

const {
  driverApplicationIssues,
  isOwnedDriverDocumentUrl,
} = require('../driver-application-policy');

const bucket = 'example.firebasestorage.app';
const uid = 'driver-1';
const url = (name) => `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/driver_documents/${uid}/${name}.jpg?alt=media&token=token`;

function validApplication() {
  return {
    email: 'driver@example.com',
    name: 'Nombre compartido permitido',
    age: 35,
    phone: '+51999111222',
    dni: '12345678',
    plate: 'ABC-123',
    vehicleBrand: 'Toyota',
    vehicleType: 'Auto',
    vehicleColor: 'Negro',
    vehicleSeats: 4,
    profilePhotoUrl: url('profile'),
    dniFrontDocUrl: url('dni_front'),
    dniBackDocUrl: url('dni_back'),
    licenseDocUrl: url('license'),
    soatDocUrl: url('soat'),
    circulationCardDocUrl: url('circulation'),
    technicalReviewDocUrl: url('technical'),
    criminalRecordDocUrl: url('record'),
    workCertificateDocUrl: url('work'),
  };
}

test('acepta una solicitud completa con DNI en dos imágenes', () => {
  assert.deepEqual(driverApplicationIssues(validApplication(), uid, bucket, 1_000), []);
});

test('acepta un único PDF para el DNI', () => {
  const application = validApplication();
  delete application.dniFrontDocUrl;
  delete application.dniBackDocUrl;
  application.dniDocUrl = url('dni.pdf');

  assert.deepEqual(driverApplicationIssues(application, uid, bucket, 1_000), []);
});

test('rechaza documentos ajenos o faltantes sin exigir fechas de caducidad', () => {
  const application = validApplication();
  application.profilePhotoUrl = url('profile').replace('/driver-1/', '/driver-2/');
  delete application.workCertificateDocUrl;

  const issues = driverApplicationIssues(application, uid, bucket, 1_000);
  assert.ok(issues.includes('foto de perfil'));
  assert.ok(issues.includes('certificado laboral'));
  assert.deepEqual(issues.sort(), ['certificado laboral', 'foto de perfil'].sort());
});

test('solo admite URLs HTTPS del prefijo de Storage autenticado', () => {
  assert.equal(isOwnedDriverDocumentUrl(url('license'), uid, bucket), true);
  assert.equal(isOwnedDriverDocumentUrl('https://example.com/license.jpg', uid, bucket), false);
  assert.equal(isOwnedDriverDocumentUrl(url('license').replace('https:', 'http:'), uid, bucket), false);
});
