// ---------------------------------------------------------------------------
// Seccion "Conductores": aprobacion manual de documentos de registro.
// Suscripcion propia a /drivers (independiente de driversCache de app.js)
// para no arriesgar la logica del mapa ya existente.
// ---------------------------------------------------------------------------

const DOC_FIELDS = [
  { key: 'dniDocUrl', label: 'DNI' },
  { key: 'licenseDocUrl', label: 'Licencia' },
  { key: 'soatDocUrl', label: 'SOAT' },
  { key: 'circulationCardDocUrl', label: 'Tarjeta circ.' },
  { key: 'technicalReviewDocUrl', label: 'Rev. técnica' },
  { key: 'criminalRecordDocUrl', label: 'Récord' },
  { key: 'workCertificateDocUrl', label: 'Cert. laboral' },
];

const APPROVAL_LABELS = {
  pending_review: 'Pendiente',
  approved: 'Aprobado',
  rejected: 'Rechazado',
};

let adminDriversCache = {};
let adminSubscribed = false;
let adminActiveFilter = 'pending_review';
let openRejectFormId = null;

const mapViewEl = document.getElementById('map-view');
const adminViewEl = document.getElementById('drivers-admin-view');
const pendingBadgeEl = document.getElementById('pending-badge');
const navTabs = document.querySelectorAll('.nav-tab');

function openDashboardView(view) {
  navTabs.forEach((tab) => tab.classList.toggle('active', tab.getAttribute('data-view') === view));
  mapViewEl.classList.toggle('hidden', view !== 'map');
  adminViewEl.classList.toggle('hidden', view !== 'drivers-admin');
  placesViewEl.classList.toggle('hidden', view !== 'places');
  settingsViewEl.classList.toggle('hidden', view !== 'settings');
  if (view === 'drivers-admin') startDriversAdmin();
  if (view === 'places') startPlaces();
  if (view === 'settings') {
    // El boton superior siempre vuelve al inicio de Configuracion, incluso
    // cuando se esta dentro de Usuarios, Apps o Actualizaciones.
    settingsSection = 'home';
    startSettings();
    renderSettings();
  }
  if (view === 'map' && map && window.google?.maps) window.google.maps.event.trigger(map, 'resize');
}

navTabs.forEach((tab) => tab.addEventListener('click', () => openDashboardView(tab.getAttribute('data-view'))));
document.getElementById('dashboard-home-link').addEventListener('click', () => openDashboardView('map'));

function startDriversAdmin() {
  if (adminSubscribed) return;
  adminSubscribed = true;
  db.ref('drivers').on('value', (snapshot) => {
    adminDriversCache = snapshot.val() || {};
    updatePendingBadge();
    renderDriversAdmin();
  });
}

function updatePendingBadge() {
  const pendingCount = Object.values(adminDriversCache).filter(
    (d) => d.approvalStatus === 'pending_review'
  ).length;
  pendingBadgeEl.textContent = String(pendingCount);
  pendingBadgeEl.classList.toggle('hidden', pendingCount === 0);
}

function isPdfUrl(url) {
  return /\.pdf(\?|$)/i.test(url || '');
}

function docCellHtml(driverId, field, url) {
  if (!url) {
    return `
      <div class="doc-item">
        <div class="doc-missing" title="No subido">—</div>
        <div class="doc-label">${escapeHtml(field.label)}</div>
      </div>
    `;
  }
  const cell = isPdfUrl(url)
    ? `<a class="doc-pdf-link" href="${url}" target="_blank" rel="noopener" onclick="event.stopPropagation()">📄</a>`
    : `<img class="doc-thumb" src="${url}" alt="${escapeHtml(field.label)}" onclick="window.open('${url}', '_blank')" />`;
  return `
    <div class="doc-item">
      ${cell}
      <div class="doc-label">${escapeHtml(field.label)}</div>
    </div>
  `;
}

function driverAdminCardHtml(driverId, d) {
  const status = d.approvalStatus || 'pending_review';
  const docsHtml = DOC_FIELDS.map((f) => docCellHtml(driverId, f, d[f.key])).join('');
  const rejectFormOpen = openRejectFormId === driverId;

  const rejectionBlock =
    status === 'rejected' && d.rejectionReason
      ? `<div class="rejection-note"><b>Motivo del rechazo:</b> ${escapeHtml(d.rejectionReason)}</div>`
      : '';

  const actionsHtml =
    status === 'pending_review' || status === 'rejected'
      ? `
        <div class="driver-admin-actions">
          <button type="button" class="approve-btn" data-action="approve" data-id="${driverId}">Aprobar</button>
          <button type="button" class="reject-btn" data-action="reject" data-id="${driverId}">Rechazar</button>
        </div>
        ${
          rejectFormOpen
            ? `
          <form class="reject-form" data-reject-form="${driverId}">
            <input type="text" placeholder="Motivo del rechazo (ej. SOAT vencido)" required />
            <button type="submit" class="reject-btn">Confirmar</button>
          </form>
        `
            : ''
        }
      `
      : '';

  return `
    <div class="driver-admin-card" data-id="${driverId}">
      <div class="driver-admin-card-header">
        <img class="driver-admin-avatar" src="${d.profilePhotoUrl || ''}" alt="" onerror="this.style.visibility='hidden'" />
        <div>
          <div class="driver-admin-name">${escapeHtml(d.name || 'Sin nombre')}</div>
          <div class="driver-admin-meta">${escapeHtml(d.email || '-')} &middot; DNI ${escapeHtml(d.dni || '-')}</div>
        </div>
        <span class="status-badge ${status}">${APPROVAL_LABELS[status] || status}</span>
      </div>
      <div class="detail-section">
        <div class="row"><b>Teléfono:</b> ${escapeHtml(d.phone || '-')}</div>
        <div class="row"><b>Placa:</b> ${escapeHtml(d.plate || '-')}</div>
        <div class="row"><b>Edad:</b> ${escapeHtml(String(d.age ?? '-'))}</div>
      </div>
      ${rejectionBlock}
      <div class="doc-grid">${docsHtml}</div>
      <div class="driver-admin-actions">
        <button type="button" class="view-file-btn" data-action="view-file" data-id="${driverId}">Ver archivo completo</button>
      </div>
      ${actionsHtml}
    </div>
  `;
}

function renderDriversAdmin() {
  const entries = Object.entries(adminDriversCache).filter(([, d]) => {
    if (adminActiveFilter === 'all') return true;
    return (d.approvalStatus || 'pending_review') === adminActiveFilter;
  });

  const toolbarHtml = `
    <div class="drivers-admin-toolbar">
      ${['pending_review', 'approved', 'rejected', 'all']
        .map(
          (f) => `
        <button type="button" class="filter-pill ${adminActiveFilter === f ? 'active' : ''}" data-admin-filter="${f}">
          ${f === 'all' ? 'Todos' : APPROVAL_LABELS[f]}
        </button>
      `
        )
        .join('')}
    </div>
  `;

  const gridHtml = entries.length
    ? `<div class="driver-admin-grid">${entries.map(([id, d]) => driverAdminCardHtml(id, d)).join('')}</div>`
    : '<p class="drivers-admin-empty">Sin conductores para este filtro.</p>';

  adminViewEl.innerHTML = toolbarHtml + gridHtml;

  adminViewEl.querySelectorAll('[data-admin-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      adminActiveFilter = btn.getAttribute('data-admin-filter');
      renderDriversAdmin();
    });
  });

  adminViewEl.querySelectorAll('[data-action="approve"]').forEach((btn) => {
    btn.addEventListener('click', () => approveDriver(btn.getAttribute('data-id')));
  });

  adminViewEl.querySelectorAll('[data-action="view-file"]').forEach((btn) => {
    btn.addEventListener('click', () => downloadDriverPdf(btn));
  });

  adminViewEl.querySelectorAll('[data-action="reject"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openRejectFormId = openRejectFormId === btn.getAttribute('data-id') ? null : btn.getAttribute('data-id');
      renderDriversAdmin();
    });
  });

  adminViewEl.querySelectorAll('[data-reject-form]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const driverId = form.getAttribute('data-reject-form');
      const reason = form.querySelector('input').value.trim();
      if (!reason) return;
      rejectDriver(driverId, reason);
    });
  });
}

function approveDriver(driverId) {
  db.ref(`drivers/${driverId}`).update({
    approvalStatus: 'approved',
    rejectionReason: null,
    reviewedAt: Date.now(),
    reviewedBy: auth.currentUser ? auth.currentUser.email : null,
  });
}

function rejectDriver(driverId, reason) {
  db.ref(`drivers/${driverId}`).update({
    approvalStatus: 'rejected',
    rejectionReason: reason,
    reviewedAt: Date.now(),
    reviewedBy: auth.currentUser ? auth.currentUser.email : null,
  });
  openRejectFormId = null;
}

// ---------------------------------------------------------------------------
// "Ver archivo completo": genera un PDF con todos los datos del conductor y
// CADA documento incrustado como imagen (las fotos tal cual, y los PDFs
// subidos -SOAT, licencia, etc.- renderizados a imagen con pdf.js) para que
// todo se vea de un vistazo, sin tener que abrir archivos aparte.
// ---------------------------------------------------------------------------

async function fetchAsDataUrl(url) {
  // cache: 'no-store' evita que una respuesta cacheada sin CORS (de una
  // carga previa como <img>, sin modo 'cors') bloquee este fetch.
  const response = await fetch(url, { mode: 'cors', cache: 'no-store' });
  if (!response.ok) throw new Error(`fetch ${response.status}`);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Descarga un PDF subido como documento y dibuja su primera pagina en un
// canvas, devolviendo esa imagen como data URL (mismo formato que
// fetchAsDataUrl) para poder incrustarla igual que una foto.
async function renderPdfFirstPageAsDataUrl(url) {
  const response = await fetch(url, { mode: 'cors', cache: 'no-store' });
  if (!response.ok) throw new Error(`fetch ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvas.toDataURL('image/jpeg', 0.9);
}

async function documentAsDataUrl(url) {
  return isPdfUrl(url) ? renderPdfFirstPageAsDataUrl(url) : fetchAsDataUrl(url);
}

async function downloadDriverPdf(button) {
  const driverId = button.getAttribute('data-id');
  const d = adminDriversCache[driverId];
  if (!d) return;

  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Generando PDF...';

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 40;
    let y = margin;

    function ensureSpace(height) {
      if (y + height > pageHeight - margin) {
        doc.addPage();
        y = margin;
      }
    }

    const status = d.approvalStatus || 'pending_review';

    doc.setFontSize(18);
    doc.setFont(undefined, 'bold');
    doc.text(d.name || 'Conductor', margin, y);
    y += 22;

    doc.setFontSize(11);
    doc.setFont(undefined, 'normal');
    doc.setTextColor(100);
    doc.text(`Estado: ${APPROVAL_LABELS[status] || status}`, margin, y);
    y += 24;
    doc.setTextColor(0);

    if (d.profilePhotoUrl) {
      try {
        const dataUrl = await fetchAsDataUrl(d.profilePhotoUrl);
        const props = doc.getImageProperties(dataUrl);
        const w = 90;
        const h = (props.height / props.width) * w;
        doc.addImage(dataUrl, props.fileType || 'JPEG', pageWidth - margin - w, margin, w, h);
      } catch (e) {
        // Sin foto de perfil legible: se omite, el resto del PDF sigue igual.
        console.error('No se pudo cargar la foto de perfil:', e);
      }
    }

    const fields = [
      ['Correo', d.email],
      ['DNI', d.dni],
      ['Teléfono', d.phone],
      ['Placa', d.plate],
      ['Edad', d.age != null ? String(d.age) : null],
      ['Registrado', d.registeredAt ? new Date(d.registeredAt).toLocaleString() : null],
      ['Documentos enviados', d.documentsSubmittedAt ? new Date(d.documentsSubmittedAt).toLocaleString() : null],
      ['Revisado', d.reviewedAt ? new Date(d.reviewedAt).toLocaleString() : null],
      ['Revisado por', d.reviewedBy || null],
    ];
    if (status === 'rejected' && d.rejectionReason) {
      fields.push(['Motivo de rechazo', d.rejectionReason]);
    }

    doc.setFontSize(11);
    fields.forEach(([label, value]) => {
      ensureSpace(18);
      doc.setFont(undefined, 'bold');
      doc.text(`${label}:`, margin, y);
      doc.setFont(undefined, 'normal');
      doc.text(value || '-', margin + 150, y);
      y += 18;
    });

    // Un documento por hoja, con su nombre como titulo arriba de la
    // imagen -- mas facil de revisar/imprimir uno por uno que la
    // cuadricula compartiendo pagina de antes.
    for (const field of DOC_FIELDS) {
      const url = d[field.key];
      doc.addPage();
      y = margin;

      doc.setFontSize(16);
      doc.setFont(undefined, 'bold');
      doc.text(field.label, margin, y);
      y += 28;
      doc.setFont(undefined, 'normal');
      doc.setFontSize(11);

      if (!url) {
        doc.setTextColor(150);
        doc.text('No subido', margin, y);
        doc.setTextColor(0);
        continue;
      }

      try {
        const dataUrl = await documentAsDataUrl(url);
        const props = doc.getImageProperties(dataUrl);
        const maxWidth = pageWidth - margin * 2;
        const maxHeight = pageHeight - y - margin;
        const scale = Math.min(maxWidth / props.width, maxHeight / props.height, 1);
        const w = props.width * scale;
        const h = props.height * scale;
        doc.addImage(dataUrl, props.fileType || 'JPEG', margin, y, w, h);
      } catch (e) {
        console.error(`No se pudo cargar "${field.label}" (${url}):`, e);
        doc.setTextColor(200, 0, 0);
        doc.text(`(no se pudo cargar: ${e.message || e})`, margin, y);
        doc.setTextColor(0);
      }
    }

    const slug = (s) => (s || '').trim().replace(/\s+/g, '_').replace(/[\\/:*?"<>|]/g, '');
    const fileName = `${[slug(d.plate), slug(d.name)].filter(Boolean).join('_') || driverId}.pdf`;
    doc.save(fileName);
  } catch (e) {
    alert(`No se pudo generar el PDF: ${e.message || e}`);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}
